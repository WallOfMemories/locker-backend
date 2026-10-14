const { db } = require("../config/firebase");
const { getSnapWallSettings } = require("./settingsService");
const { toISO } = require("./capsuleService");

// ------------------------------------------------------------
// Wall size
//
// The wall is a grid of spaces: spaces/{id} has { row, column, status }.
// Nothing here ever moves or removes an existing space — growing the wall
// only ADDS new empty spaces, so every Snap keeps its place.
//
// Growth keeps the wall a full, roughly square rectangle: new columns are
// added on the right and new rows at the bottom (alternating), then every
// empty position in the bigger grid is filled. Because whole rows/columns
// are added, the number of new spaces can be a little more than requested.
//
// wallExpansions/{id}  — a log of every expansion (manual or automatic).
// ------------------------------------------------------------

const spacesCollection = db.collection("spaces");
const expansionsCollection = db.collection("wallExpansions");

const MAX_ADD_PER_ACTION = 500;
const MAX_TOTAL_SPACES = 2500; // every space is a tile in the browser
const BATCH_LIMIT = 400; // Firestore allows 500 writes per batch
const HISTORY_LIMIT = 20;

class WallError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// One expansion at a time inside this server process.
let expanding = false;

function spaceId(number) {
  return `space_${String(number).padStart(3, "0")}`;
}

function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(error?.message || "");
}

function toInt(value, fallback, min, max) {
  const number = Number(value);

  if (!Number.isInteger(number)) return fallback;

  return Math.min(Math.max(number, min), max);
}

// Smallest bigger grid (cols x rows) with room for `want` more spaces.
// KEEP IN SYNC with src/utils/wallGrowth.js in the frontend (used for the
// live preview on the Wall Size page).
function planGrowth(cols, rows, existing, want) {
  let c = cols;
  let r = rows;

  while (c * r - existing < want) {
    if (c <= r) c += 1;
    else r += 1;
  }

  return { cols: c, rows: r, add: c * r - existing };
}

// ---------- read ----------

async function getWallInfo() {
  const snapshot = await spacesCollection
    .select("row", "column", "status")
    .get();

  let cols = 0;
  let rows = 0;
  let occupied = 0;

  // [row, column, occupied(1|0)] — small enough to draw the preview map.
  const cells = [];

  snapshot.docs.forEach((doc) => {
    const data = doc.data();

    const row = Number.isInteger(data.row) ? data.row : 0;
    const column = Number.isInteger(data.column) ? data.column : 0;
    const isOccupied = data.status === "occupied";

    cols = Math.max(cols, column + 1);
    rows = Math.max(rows, row + 1);
    if (isOccupied) occupied += 1;

    cells.push([row, column, isOccupied ? 1 : 0]);
  });

  const total = snapshot.size;

  return {
    cols,
    rows,
    total,
    occupied,
    available: total - occupied,
    occupancyPercent: total ? Math.round((occupied / total) * 1000) / 10 : 0,
    cells,
  };
}

async function listExpansions() {
  const snapshot = await expansionsCollection
    .orderBy("createdAt", "desc")
    .limit(HISTORY_LIMIT)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();

    return {
      id: doc.id,
      source: data.source || "manual",
      requested: data.requested || 0,
      added: data.added || 0,
      fromCols: data.fromCols || 0,
      fromRows: data.fromRows || 0,
      toCols: data.toCols || 0,
      toRows: data.toRows || 0,
      totalAfter: data.totalAfter || 0,
      by: data.by || "",
      createdAt: toISO(data.createdAt),
    };
  });
}

// ---------- expand ----------

async function expandWall({ count, source = "manual", adminId = "system" }) {
  const want = Number(count);

  if (!Number.isInteger(want) || want < 1 || want > MAX_ADD_PER_ACTION) {
    throw new WallError(
      400,
      `Enter a whole number between 1 and ${MAX_ADD_PER_ACTION}.`
    );
  }

  if (expanding) {
    throw new WallError(
      409,
      "The wall is already being expanded. Try again in a moment."
    );
  }

  expanding = true;

  try {
    const snapshot = await spacesCollection.select("row", "column").get();

    const taken = new Set();
    let cols = 0;
    let rows = 0;
    let maxNumber = 0;

    snapshot.docs.forEach((doc) => {
      const data = doc.data();

      const row = Number.isInteger(data.row) ? data.row : 0;
      const column = Number.isInteger(data.column) ? data.column : 0;

      taken.add(`${row}:${column}`);
      cols = Math.max(cols, column + 1);
      rows = Math.max(rows, row + 1);

      const match = /^space_(\d+)$/.exec(doc.id);
      if (match) maxNumber = Math.max(maxNumber, Number(match[1]));
    });

    const total = snapshot.size;
    const plan = planGrowth(cols, rows, total, want);

    if (total + plan.add > MAX_TOTAL_SPACES) {
      throw new WallError(
        400,
        `The wall can hold at most ${MAX_TOTAL_SPACES} spaces. This would make it ${
          total + plan.add
        }.`
      );
    }

    // Every empty position of the bigger grid, row by row.
    const missing = [];

    for (let row = 0; row < plan.rows; row += 1) {
      for (let column = 0; column < plan.cols; column += 1) {
        if (!taken.has(`${row}:${column}`)) missing.push({ row, column });
      }
    }

    const now = new Date();

    try {
      for (let i = 0; i < missing.length; i += BATCH_LIMIT) {
        const batch = db.batch();

        missing.slice(i, i + BATCH_LIMIT).forEach((cell, index) => {
          // create() (not set()) so an existing space can never be
          // overwritten, even if two expansions race each other.
          batch.create(
            spacesCollection.doc(spaceId(maxNumber + i + index + 1)),
            {
              row: cell.row,
              column: cell.column,
              width: 1,
              height: 1,
              status: "available",
              snapId: null,
              createdAt: now,
              addedBy: source,
            }
          );
        });

        await batch.commit();
      }
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new WallError(
          409,
          "The wall was just changed by someone else. Refresh and try again."
        );
      }

      throw error;
    }

    const result = {
      added: missing.length,
      fromCols: cols,
      fromRows: rows,
      toCols: plan.cols,
      toRows: plan.rows,
      totalAfter: total + missing.length,
    };

    // The log is a nice-to-have; never fail an expansion that worked.
    try {
      await expansionsCollection.add({
        ...result,
        source,
        requested: want,
        by: adminId,
        createdAt: now,
      });
    } catch (error) {
      console.error("Could not log wall expansion:", error);
    }

    return result;
  } finally {
    expanding = false;
  }
}

// Called after a Snap is posted. If auto-expansion is switched on and the
// wall is at least `expansionThreshold` % full, adds `expansionBatchSize`
// spaces. Uses cheap count queries, so it is fine to call on every post.
async function autoExpandIfNeeded() {
  if (expanding) return null;

  const settings = await getSnapWallSettings();

  if (!settings || settings.autoExpand !== true) return null;

  const threshold = toInt(settings.expansionThreshold, 80, 1, 100);
  const batchSize = toInt(
    settings.expansionBatchSize,
    50,
    1,
    MAX_ADD_PER_ACTION
  );

  const [totalSnap, occupiedSnap] = await Promise.all([
    spacesCollection.count().get(),
    spacesCollection.where("status", "==", "occupied").count().get(),
  ]);

  const total = totalSnap.data().count;
  const occupied = occupiedSnap.data().count;

  if (total === 0 || total >= MAX_TOTAL_SPACES) return null;
  if ((occupied / total) * 100 < threshold) return null;

  return expandWall({
    count: batchSize,
    source: "auto",
    adminId: "system",
  });
}

module.exports = {
  WallError,
  MAX_ADD_PER_ACTION,
  MAX_TOTAL_SPACES,
  planGrowth,
  getWallInfo,
  listExpansions,
  expandWall,
  autoExpandIfNeeded,
};
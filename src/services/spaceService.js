const { db } = require("../config/firebase");
const { isSnapLocked, toISO } = require("./capsuleService");

const spacesCollection = db.collection("spaces");

// Returns every space. Occupied spaces also carry the public snap
// fields the wall needs: image, caption, username, displayName.
async function getAllSpaces() {
  const snapshot = await spacesCollection
    .orderBy("createdAt", "asc")
    .get();

  const spaces = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  const snapIds = [
    ...new Set(
      spaces
        .filter((space) => space.status === "occupied" && space.snapId)
        .map((space) => space.snapId)
    ),
  ];

  if (snapIds.length === 0) {
    return spaces;
  }

  const snapDocs = await db.getAll(
    ...snapIds.map((id) => db.collection("snaps").doc(id))
  );

  const snapsById = {};

  snapDocs.forEach((doc) => {
    if (doc.exists) snapsById[doc.id] = doc.data();
  });

  const userIds = [
    ...new Set(
      Object.values(snapsById)
        .map((snap) => snap.userId)
        .filter(Boolean)
    ),
  ];

  const usersById = {};

  if (userIds.length > 0) {
    const userDocs = await db.getAll(
      ...userIds.map((id) => db.collection("users").doc(id))
    );

    userDocs.forEach((doc) => {
      if (doc.exists) usersById[doc.id] = doc.data();
    });
  }

  return spaces.map((space) => {
    const snap = snapsById[space.snapId];

    if (space.status !== "occupied" || !snap) {
      return space;
    }

    const user = usersById[snap.userId] || {};

    // Time Capsule that hasn't unlocked yet: the space stays reserved but
    // the photo and caption are NOT sent to the browser. They are added
    // automatically once unlockAt passes.
    if (isSnapLocked(snap)) {
      return {
        ...space,
        ownerId: snap.userId || "",
        locked: true,
        unlockAt: toISO(snap.unlockAt),
        username: user.username || "",
        displayName: user.displayName || "",
      };
    }

    // Hidden by an admin: the space stays taken, but the photo and caption
    // are NOT sent to the browser.
    if (snap.status === "hidden") {
      return {
        ...space,
        ownerId: snap.userId || "",
        hidden: true,
        username: user.username || "",
        displayName: user.displayName || "",
      };
    }

    return {
      ...space,
      ownerId: snap.userId || "",
      image: snap.imageUrl || "",
      caption: snap.caption || "",
      location: snap.location || null,
      username: user.username || "",
      displayName: user.displayName || "",
    };
  });
}

async function createInitialSpaces() {
  const existingSnapshot = await spacesCollection.get();

  const existingCount = existingSnapshot.size;

  const targetCount = 100;

  if (existingCount >= targetCount) {
    return {
      created: 0,
      total: existingCount,
    };
  }

  const batch = db.batch();

  let created = 0;

  for (let index = existingCount; index < targetCount; index++) {
    const row = Math.floor(index / 10);
    const column = index % 10;

    const spaceId = `space_${String(index + 1).padStart(3, "0")}`;

    const spaceRef = spacesCollection.doc(spaceId);

    batch.set(spaceRef, {
      row,
      column,
      width: 1,
      height: 1,
      status: "available",
      snapId: null,
      createdAt: new Date(),
    });

    created++;
  }

  await batch.commit();

  return {
    created,
    total: existingCount + created,
  };
}

module.exports = {
  getAllSpaces,
  createInitialSpaces,
};
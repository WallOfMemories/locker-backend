const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// A shared Snap link may only reveal what the wall already shows publicly.

function load(snaps, users) {
  const collections = { snaps, users };

  const stub = (relative, exports) => {
    const file = require.resolve(path.join(__dirname, "..", "src", relative));

    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };

  stub("config/firebase.js", {
    db: {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => {
            const value = collections[name][id];

            return { exists: value !== undefined, data: () => value };
          },
        }),
      }),
    },
  });
  stub("services/capsuleService.js", {
    isSnapLocked: (snap) => snap.unlockAt && new Date(snap.unlockAt).getTime() > Date.now(),
    toISO: (value) => (value ? new Date(value).toISOString() : null),
  });
  stub("services/privacyService.js", {
    getPrivacy: (user) => ({ showLocation: user.showLocation !== false }),
  });

  delete require.cache[require.resolve("../src/services/snapPreviewService.js")];

  return require("../src/services/snapPreviewService.js");
}

const users = {
  u1: { username: "santhosh1703", displayName: "Santhosh" },
  u2: { username: "private", displayName: "Hidden Loc", showLocation: false },
};

test("a normal Snap shows its photo, caption, public name and country", async () => {
  const { getSnapPreview } = load(
    { s1: { userId: "u1", imageUrl: "https://firebasestorage.googleapis.com/x.jpg", caption: "Sweet Memory", location: { name: "India" } } },
    users
  );

  assert.deepEqual(await getSnapPreview("s1"), {
    available: true,
    image: "https://firebasestorage.googleapis.com/x.jpg",
    caption: "Sweet Memory",
    username: "santhosh1703",
    displayName: "Santhosh",
    country: "India",
  });
});

test("an unknown Snap is 'not found'", async () => {
  assert.equal(await load({}, users).getSnapPreview("nope"), null);
});

test("a locked Time Capsule reveals no photo and no caption", async () => {
  const unlockAt = new Date(Date.now() + 86400000).toISOString();
  const { getSnapPreview } = load(
    { s1: { userId: "u1", imageUrl: "https://firebasestorage.googleapis.com/secret.jpg", caption: "secret", unlockAt } },
    users
  );

  const preview = await getSnapPreview("s1");

  assert.equal(preview.available, false);
  assert.equal(preview.reason, "locked");
  assert.equal(preview.image, undefined);
  assert.equal(preview.caption, undefined);
  assert.equal(preview.unlockAt, unlockAt);
});

test("a Snap hidden by a moderator or by its owner reveals nothing", async () => {
  const { getSnapPreview } = load(
    {
      s1: { userId: "u1", imageUrl: "https://x/1.jpg", caption: "a", status: "hidden" },
      s2: { userId: "u1", imageUrl: "https://x/2.jpg", caption: "b", ownerHidden: true },
    },
    users
  );

  for (const id of ["s1", "s2"]) {
    const preview = await getSnapPreview(id);

    assert.deepEqual(preview, { available: false, reason: "hidden" });
  }
});

test("the owner's 'hide my location' setting is respected", async () => {
  const { getSnapPreview } = load(
    { s1: { userId: "u2", imageUrl: "https://x/1.jpg", caption: "a", location: { name: "India" } } },
    users
  );

  assert.equal((await getSnapPreview("s1")).country, "");
});
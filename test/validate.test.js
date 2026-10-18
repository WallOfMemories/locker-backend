const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isSafeId,
  isSpaceId,
  isOwnSnapStoragePath,
  isFirebaseDownloadUrl,
  isAllowedPhotoUrl,
} = require("../src/utils/validate");

const BUCKET = "demo.firebasestorage.app";
const PATH = "snaps/uid123/1-abc.jpg";
const url = (bucket, path, extra = "?alt=media&token=t") =>
  `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(path)}${extra}`;

test("ids", () => {
  assert.ok(isSafeId("AbC123_-"));
  assert.ok(!isSafeId("a/b"));
  assert.ok(!isSafeId(".."));
  assert.ok(!isSafeId("__name__"));
  assert.ok(!isSafeId({ $ne: 1 }));
  assert.ok(isSpaceId("space_001"));
  assert.ok(!isSpaceId("space_1/../x"));
  assert.ok(!isSpaceId(undefined));
});

test("storage path must be inside the caller's own folder", () => {
  assert.ok(isOwnSnapStoragePath(PATH, "uid123"));
  assert.ok(!isOwnSnapStoragePath(PATH, "someoneElse"));
  assert.ok(!isOwnSnapStoragePath("snaps/uid123/../victim/x.jpg", "uid123"));
  assert.ok(!isOwnSnapStoragePath("snaps/uid123/", "uid123"));
  assert.ok(!isOwnSnapStoragePath("users/uid123/profile/x.jpg", "uid123"));
});

test("image url must be our bucket + match the storage path", () => {
  const opts = { bucket: BUCKET, storagePath: PATH };
  assert.ok(isFirebaseDownloadUrl(url(BUCKET, PATH), opts));
  assert.ok(!isFirebaseDownloadUrl(url("other-bucket", PATH), opts));
  assert.ok(!isFirebaseDownloadUrl(url(BUCKET, "snaps/uid123/other.jpg"), opts));
  assert.ok(!isFirebaseDownloadUrl("http://firebasestorage.googleapis.com/v0/b/x/o/y", opts));
  assert.ok(!isFirebaseDownloadUrl("https://evil.example/pixel.png", opts));
  assert.ok(!isFirebaseDownloadUrl("javascript:alert(1)", opts));
  assert.ok(!isFirebaseDownloadUrl("https://firebasestorage.googleapis.com.evil.com/v0/b/x/o/y", opts));
});

test("profile photo", () => {
  assert.ok(isAllowedPhotoUrl(""));
  assert.ok(isAllowedPhotoUrl("https://lh3.googleusercontent.com/a/abc"));
  assert.ok(isAllowedPhotoUrl(url(BUCKET, "users/u/profile/a.png"), { bucket: BUCKET }));
  assert.ok(!isAllowedPhotoUrl(url("x", "users/u/profile/a.png"), { bucket: BUCKET }));
  assert.ok(!isAllowedPhotoUrl("https://evil.example/a.png"));
  assert.ok(!isAllowedPhotoUrl("javascript:alert(1)"));
  assert.ok(!isAllowedPhotoUrl("data:image/png;base64,AAAA"));
});

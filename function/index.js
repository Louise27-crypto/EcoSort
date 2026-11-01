const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const crypto = require("node:crypto");

admin.initializeApp();

const db = admin.database();
const auth = admin.auth();
const REGION = "asia-southeast1";

const hash = value =>
  crypto.createHash("sha256").update(value).digest("hex");

const normalizeId = value =>
  String(value ?? "").trim().toLowerCase();

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError(
      "permission-denied",
      "Administrator privileges are required."
    );
  }
}

function pinHash(pin, salt) {
  return crypto.scryptSync(pin, salt, 64).toString("hex");
}

function validPin(pin, salt, storedHash) {
  const actual = Buffer.from(pinHash(pin, salt), "hex");
  const expected = Buffer.from(storedHash, "hex");

  return actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected);
}

exports.createUserAccount = onCall({ region: REGION }, async request => {
  requireAdmin(request);

  const fullName = String(request.data.fullName ?? "").trim();
  const idNumber = String(request.data.idNumber ?? "").trim();
  const username = String(request.data.username ?? "")
    .trim().replace(/^@/, "");

  if (fullName.length < 2 || fullName.length > 120) {
    throw new HttpsError("invalid-argument", "Enter a valid full name.");
  }

  if (!idNumber || idNumber.length > 64) {
    throw new HttpsError("invalid-argument", "Enter a valid ID number.");
  }

  if (username && !/^[a-zA-Z0-9_.-]{2,28}$/.test(username)) {
    throw new HttpsError("invalid-argument", "Invalid username format.");
  }

  const idKey = hash(normalizeId(idNumber));
  const usernameKey = username ? hash(username.toLowerCase()) : null;

  const idRef = db.ref(`ecosort/idIndex/${idKey}`);
  const usernameRef = usernameKey
    ? db.ref(`ecosort/usernameIndex/${usernameKey}`)
    : null;

  // A transaction prevents two requests from claiming the same ID key.
  const claim = await idRef.transaction(current => current || "__PENDING__");

  if (!claim.committed || claim.snapshot.val() !== "__PENDING__") {
    throw new HttpsError("already-exists", "That ID is already registered.");
  }

  let uid;

  try {
    if (usernameRef) {
      const userClaim = await usernameRef.transaction(
        current => current || "__PENDING__"
      );

      if (!userClaim.committed || userClaim.snapshot.val() !== "__PENDING__") {
        throw new HttpsError("already-exists", "That username is already taken.");
      }
    }

    uid = "eco_" + crypto.randomBytes(18).toString("hex");

    const qrToken = crypto.randomBytes(32).toString("base64url");
    const qrHash = hash(qrToken);
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");

    const account = {
      uid,
      fullName,
      idNumber,
      username,
      role: "Student",
      active: true,
      qrTokenHash: qrHash,
      pinSalt: salt,
      pinHash: pinHash(pin, salt),
      createdAt: Date.now()
    };

    await auth.createUser({ uid, displayName: fullName });
    await auth.setCustomUserClaims(uid, { role: "user" });

    const updates = {};
    updates[`ecosort/accounts/${uid}`] = account;
    updates[`ecosort/qrIndex/${qrHash}`] = uid;
    updates[`ecosort/idIndex/${idKey}`] = uid;

    if (usernameKey) updates[`ecosort/usernameIndex/${usernameKey}`] = uid;

    await db.ref().update(updates);

    return {
      fullName,
      pin,
      qrPayload: `ECOSORT1:${qrToken}`
    };
  } catch (error) {
    // Release any temporary claims if account creation failed.
    await idRef.transaction(current =>
      current === "__PENDING__" ? null : current
    );

    if (usernameRef) {
      await usernameRef.transaction(current =>
        current === "__PENDING__" ? null : current
      );
    }

    if (uid) await auth.deleteUser(uid).catch(() => {});

    if (error instanceof HttpsError) throw error;

    throw new HttpsError("internal", "Account creation failed.");
  }
});

exports.loginWithQr = onCall({ region: REGION }, async request => {
  const payload = String(request.data.payload ?? "");

  if (!payload.startsWith("ECOSORT1:")) {
    throw new HttpsError("invalid-argument", "Invalid EcoSort QR.");
  }

  const token = payload.slice("ECOSORT1:".length);

  if (token.length < 30 || token.length > 100) {
    throw new HttpsError("unauthenticated", "Invalid QR credential.");
  }

  const tokenHash = hash(token);
  const index = await db.ref(`ecosort/qrIndex/${tokenHash}`).get();

  if (!index.exists()) {
    throw new HttpsError("unauthenticated", "QR is invalid or revoked.");
  }

  const uid = index.val();
  const snapshot = await db.ref(`ecosort/accounts/${uid}`).get();
  const account = snapshot.val();

  if (!account || !account.active || account.qrTokenHash !== tokenHash) {
    throw new HttpsError("unauthenticated", "Account is inactive.");
  }

  return {
    customToken: await auth.createCustomToken(uid, { role: "user" })
  };
});

exports.loginWithIdPin = onCall({ region: REGION }, async request => {
  const idNumber = String(request.data.idNumber ?? "").trim();
  const pin = String(request.data.pin ?? "").trim();

  if (!idNumber || !/^\d{6}$/.test(pin)) {
    throw new HttpsError("invalid-argument", "Enter your ID and six-digit PIN.");
  }

  const idKey = hash(normalizeId(idNumber));
  const index = await db.ref(`ecosort/idIndex/${idKey}`).get();

  if (!index.exists() || index.val() === "__PENDING__") {
    throw new HttpsError("unauthenticated", "ID or PIN is incorrect.");
  }

  const uid = index.val();
  const snapshot = await db.ref(`ecosort/accounts/${uid}`).get();
  const account = snapshot.val();

  if (!account || !account.active ||
      !validPin(pin, account.pinSalt, account.pinHash)) {
    throw new HttpsError("unauthenticated", "ID or PIN is incorrect.");
  }

  return {
    customToken: await auth.createCustomToken(uid, { role: "user" })
  };
});

exports.getMyAccount = onCall({ region: REGION }, async request => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Please log in.");
  }

  const snapshot = await db.ref(
    `ecosort/accounts/${request.auth.uid}`
  ).get();

  const account = snapshot.val();

  if (!account || !account.active) {
    throw new HttpsError("permission-denied", "Account is inactive.");
  }

  // Return only fields needed by the frontend.
  return {
    uid: account.uid,
    fullName: account.fullName,
    idNumber: account.idNumber,
    username: account.username || "",
    role: account.role || "Student"
  };
});

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  set,
  onValue
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "ecosort-ai-v1";
const ADMIN_KEY = "ecosort-admin-passcode";

const DEFAULT_BINS = [
  { id: "bin-bio", name: "Biodegradable", category: "Biodegradable", room: "General" },
  { id: "bin-recycle", name: "Recyclable", category: "Recyclable", room: "General" },
  { id: "bin-residual", name: "Residual", category: "Residual", room: "General" },
  { id: "bin-hazard", name: "Hazardous", category: "Hazardous", room: "General" }
];

const CATEGORY_MAP = {
  "banana peel": "Biodegradable",
  "food scraps": "Biodegradable",
  "dry leaves": "Biodegradable",
  "paper": "Recyclable",
  "cardboard": "Recyclable",
  "plastic bottle": "Recyclable",
  "aluminum can": "Recyclable",
  "glass bottle": "Recyclable",
  "plastic wrapper": "Residual",
  "foam container": "Residual",
  "battery": "Hazardous",
  "other / unlisted item": "Residual"
};

const COCO_MAP = {
  bottle: "plastic bottle",
  cup: "other / unlisted item",
  bowl: "other / unlisted item",
  apple: "food scraps",
  banana: "banana peel",
  sandwich: "food scraps",
  orange: "food scraps",
  broccoli: "food scraps",
  carrot: "food scraps",
  potted_plant: "dry leaves",
  book: "paper",
  cell_phone: "other / unlisted item"
};

let state = loadState();
let db = null;
let firebaseReady = false;
let stream = null;
let model = null;
let cameraTimer = null;
let currentWaste = "";
let selectedBin = "";
let currentQrUser = "";
let adminUnlocked = false;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return {
      profile: s.profile || null,
      bins: Array.isArray(s.bins) && s.bins.length ? s.bins : DEFAULT_BINS,
      records: Array.isArray(s.records) ? s.records : [],
      users: s.users || {}
    };
  } catch {
    return {
      profile: null,
      bins: DEFAULT_BINS,
      records: [],
      users: {}
    };
  }
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
  updateUI();
}

function safeId(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 50) || "guest";
}

function now() {
  return new Date().toISOString();
}

function categoryFor(item) {
  return CATEGORY_MAP[String(item).toLowerCase()] || "Residual";
}

function expectedCategory(bin) {
  return bin?.category || bin?.name || "";
}

function isCorrect(item, bin) {
  return !!bin &&
    categoryFor(item).toLowerCase() === expectedCategory(bin).toLowerCase();
}

function activeUser() {
  return state.profile?.username || currentQrUser || "guest";
}

function userRecords() {
  return state.records.filter(r => r.userId === safeId(activeUser()));
}

function pointsFor(records) {
  return records.reduce((total, record) =>
    total + (record.correct ? 10 : 0), 0);
}

function showStatus(id, message, kind = "") {
  const element = $(id);
  element.textContent = message;
  element.className = "helper" + (kind ? " " + kind : "");
}

function sound(correct) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.frequency.value = correct ? 740 : 220;
    gain.gain.value = 0.045;
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
    oscillator.onended = () => context.close();
  } catch {}
}

function feedback(correct) {
  sound(correct);
  if (navigator.vibrate) {
    navigator.vibrate(correct ? [70, 35, 70] : [180]);
  }
}

function setConnection() {
  const element = $("connection");
  if (!element) return;

  element.textContent = navigator.onLine
    ? (firebaseReady ? "Firebase connected" : "Online · local mode")
    : "Offline · saved on device";

  element.style.background = navigator.onLine ? "var(--mint)" : "#fff2dd";
  element.style.color = navigator.onLine ? "var(--green)" : "#94620d";
}

window.addEventListener("online", setConnection);
window.addEventListener("offline", setConnection);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function renderBins() {
  const options = state.bins.map(bin =>
    `<option value="${escapeHtml(bin.id)}">${escapeHtml(bin.name)} · ${escapeHtml(bin.room || "General")}</option>`
  ).join("");

  $("binSelect").innerHTML =
    '<option value="">Choose a bin…</option>' + options;

  $("qrBinSelect").innerHTML = state.bins.map(bin =>
    `<option value="${escapeHtml(bin.id)}">${escapeHtml(bin.name)} · ${escapeHtml(bin.room || "General")}</option>`
  ).join("");

  if (selectedBin && state.bins.some(bin => bin.id === selectedBin)) {
    $("binSelect").value = selectedBin;
  }

  renderAdminBins();
  updateBinHint();
}

function updateUI() {
  const mine = userRecords();
  const correct = mine.filter(record => record.correct).length;

  $("heroPoints").textContent = pointsFor(mine);
  $("totalItems").textContent = mine.length;
  $("accuracy").textContent = mine.length
    ? Math.round(correct / mine.length * 100) + "%"
    : "—";
  $("totalPoints").textContent = pointsFor(mine);

  $("selectedWaste").textContent = currentWaste || "None selected";
  $("selectedGroup").textContent = currentWaste
    ? `Expected category: ${categoryFor(currentWaste)}`
    : "Select an item to continue";

  $("logDisposal").disabled = !(
    currentWaste &&
    selectedBin &&
    state.bins.some(bin => bin.id === selectedBin)
  );

  const rows = mine.slice().reverse().slice(0, 30);

  $("activityRows").innerHTML = rows.length
    ? rows.map(record => `
      <tr>
        <td>${new Date(record.timestamp).toLocaleString()}</td>
        <td>${escapeHtml(record.item)}</td>
        <td>${escapeHtml(record.binName)}</td>
        <td>${escapeHtml(record.room)}</td>
        <td>
          <span class="${record.correct ? "good" : "bad"}">
            ${record.correct ? "Correct" : "Mis-sorted"}
          </span>
        </td>
        <td>${record.points}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="6" class="empty">No disposals recorded yet.</td></tr>';

  $("profileStatus").textContent = state.profile
    ? `Profile saved as @${state.profile.username} · ${state.profile.role} · ${state.profile.department || "No department set"}.`
    : "Create a profile to begin recording your sorting activity.";

  $("username").value = state.profile?.username
    ? "@" + state.profile.username
    : "";

  $("role").value = state.profile?.role || "Student";
  $("department").value = state.profile?.department || "";

  setConnection();
  renderAnalytics();
}

function updateBinHint() {
  const bin = state.bins.find(item => item.id === selectedBin);

  $("binHint").textContent = bin
    ? `Category: ${bin.category} · Assigned room/group: ${bin.room || "General"}`
    : "Your bin's category and room will appear here.";
}

function selectWaste(item, source = "manual") {
  currentWaste = String(item || "").trim().toLowerCase();
  if (!currentWaste) return;

  $("wasteSelect").value =
    Object.keys(CATEGORY_MAP).includes(currentWaste)
      ? currentWaste
      : "other / unlisted item";

  $("detectionResult").classList.remove("hidden");
  $("detectionResult").textContent = source === "ai"
    ? `AI suggestion: ${currentWaste}. Please confirm the item before logging.`
    : `Selected manually: ${currentWaste}.`;

  updateUI();
}

// Student, teacher, and staff profiles
$("saveProfile").addEventListener("click", () => {
  const username = safeId($("username").value);

  if (username === "guest") {
    showStatus("profileStatus", "Please enter a username or handle.");
    return;
  }

  state.profile = {
    username,
    role: $("role").value,
    department: $("department").value.trim().slice(0, 60),
    updatedAt: now()
  };

  state.users[username] = {
    ...(state.users[username] || {}),
    ...state.profile
  };

  persist();
  syncProfile();
  showStatus("profileStatus", `Profile saved as @${username}.`);
});

$("useManual").addEventListener("click", () => {
  if (!$("wasteSelect").value) {
    showStatus("disposalStatus", "Choose a waste item first.");
    return;
  }
  selectWaste($("wasteSelect").value);
});

$("wasteSelect").addEventListener("change", () => {
  if ($("wasteSelect").value) {
    selectWaste($("wasteSelect").value);
  }
});

$("binSelect").addEventListener("change", () => {
  selectedBin = $("binSelect").value;
  updateBinHint();
  updateUI();
});

// Select a user by QR text
$("applyUserQr").addEventListener("click", () => {
  const value = $("userQr").value.trim();
  if (!value) return;

  currentQrUser = value.startsWith("USER:")
    ? safeId(value.slice(5))
    : safeId(value);

  if (state.users[currentQrUser]) {
    const user = state.users[currentQrUser];

    state.profile = {
      username: currentQrUser,
      role: user.role || "Student",
      department: user.department || ""
    };

    persist();
    showStatus("disposalStatus", `User @${currentQrUser} selected.`);
  } else {
    showStatus(
      "disposalStatus",
      `User @${currentQrUser} selected for this session. Create/save a profile to register them.`
    );
    updateUI();
  }
});

// Select a bin using QR text in BIN:Name:Room format
$("applyBinQr").addEventListener("click", () => {
  const raw = $("binQr").value.trim();

  if (!raw.toUpperCase().startsWith("BIN:")) {
    showStatus("disposalStatus", "Bin QR must use BIN:BinName:Room format.");
    return;
  }

  const parts = raw.split(":");
  const name = (parts[1] || "").trim().toLowerCase();
  const room = (parts.slice(2).join(":") || "").trim().toLowerCase();

  const bin =
    state.bins.find(item =>
      item.name.toLowerCase() === name &&
      (!room || (item.room || "").toLowerCase() === room)
    ) ||
    state.bins.find(item => item.name.toLowerCase() === name);

  if (!bin) {
    showStatus("disposalStatus", "No matching bin found. Ask an administrator to add it.");
    return;
  }

  selectedBin = bin.id;
  $("binSelect").value = bin.id;
  updateBinHint();
  updateUI();

  showStatus("disposalStatus", `Bin selected: ${bin.name} · ${bin.room}.`);
});

// Log a disposal and award points
$("logDisposal").addEventListener("click", async () => {
  const bin = state.bins.find(item => item.id === selectedBin);
  if (!currentWaste || !bin) return;

  const user = activeUser();
  const correct = isCorrect(currentWaste, bin);

  const record = {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : String(Date.now()),
    userId: safeId(user),
    username: user,
    role: state.profile?.role || "Student",
    department: state.profile?.department || "Unassigned",
    item: currentWaste,
    expectedCategory: categoryFor(currentWaste),
    binId: bin.id,
    binName: bin.name,
    binCategory: bin.category,
    room: bin.room || "General",
    correct,
    points: correct ? 10 : 0,
    timestamp: now()
  };

  state.records.push(record);

  state.users[record.userId] = {
    ...(state.users[record.userId] || {}),
    username: record.userId,
    role: record.role,
    department: record.department
  };

  persist();
  syncRecord(record);
  feedback(correct);

  showStatus(
    "disposalStatus",
    correct
      ? "Correctly sorted! +10 eco-points earned."
      : "This item may belong in another category. No points awarded.",
    correct ? "success" : "warning"
  );

  currentWaste = "";
  $("wasteSelect").value = "";
  $("detectionResult").classList.add("hidden");
  updateUI();
});

$("exportMine").addEventListener("click", () => {
  downloadCsv("ecosort-my-activity.csv", userRecords());
});

// Admin panel
$("adminOpen").addEventListener("click", () => {
  $("adminDialog").showModal();
  $("adminPass").value = "";
  $("adminLoginStatus").textContent = "";
  $("adminLogin").classList.remove("hidden");
  $("adminTools").classList.add("hidden");
});

$("adminClose").addEventListener("click", () => {
  $("adminDialog").close();
});

$("adminLoginBtn").addEventListener("click", () => {
  const pass = $("adminPass").value;
  const expected = localStorage.getItem(ADMIN_KEY) || "1234";

  if (pass !== expected) {
    $("adminLoginStatus").textContent = "Incorrect passcode.";
    return;
  }

  adminUnlocked = true;
  $("adminLogin").classList.add("hidden");
  $("adminTools").classList.remove("hidden");

  renderAdminBins();
  renderAnalytics();
  generateBinQr();
});

$("adminLogout").addEventListener("click", () => {
  adminUnlocked = false;
  $("adminTools").classList.add("hidden");
  $("adminLogin").classList.remove("hidden");
});

document.querySelectorAll(".tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(item => {
      item.classList.toggle("active", item === button);
    });

    document.querySelectorAll(".admin-tab-content").forEach(element => {
      element.classList.toggle(
        "hidden",
        element.id !== "tab-" + button.dataset.tab
      );
    });

    if (button.dataset.tab === "analytics") {
      renderAnalytics();
    }
  });
});

// Add custom bins
$("addBin").addEventListener("click", () => {
  if (!adminUnlocked) return;

  const name = $("newBinName").value.trim();
  const room = $("newBinRoom").value.trim() || "General";
  const category = $("newBinCategory").value;

  if (!name) {
    alert("Enter a bin name.");
    return;
  }

  state.bins.push({
    id: "bin-" + safeId(name) + "-" + Date.now().toString(36),
    name,
    category,
    room
  });

  persist();
  renderBins();

  $("newBinName").value = "";
  $("newBinRoom").value = "";

  generateBinQr();
  syncBins();
});

function renderAdminBins() {
  if (!$("adminBinList")) return;

  $("adminBinList").innerHTML = state.bins.map(bin => `
    <div class="admin-list-item">
      <div>
        <strong>${escapeHtml(bin.name)}</strong>
        <small>${escapeHtml(bin.category)} · ${escapeHtml(bin.room || "General")}</small>
      </div>
      <button class="btn btn-danger" data-delete-bin="${escapeHtml(bin.id)}">
        Delete
      </button>
    </div>
  `).join("");

  $("adminBinList").querySelectorAll("[data-delete-bin]").forEach(button => {
    button.addEventListener("click", () => {
      const id = button.dataset.deleteBin;

      if (state.bins.length <= 1) {
        alert("Keep at least one bin.");
        return;
      }

      state.bins = state.bins.filter(bin => bin.id !== id);

      if (selectedBin === id) {
        selectedBin = "";
        $("binSelect").value = "";
      }

      persist();
      renderBins();
      generateBinQr();
      syncBins();
    });
  });
}

// Generate printable bin QR markers
$("qrBinSelect").addEventListener("change", generateBinQr);

async function generateBinQr() {
  if (!window.QRCode || !$("qrBinSelect")) return;

  const bin =
    state.bins.find(item => item.id === $("qrBinSelect").value) ||
    state.bins[0];

  if (!bin) return;

  $("qrOutput").innerHTML = "";
  const canvas = document.createElement("canvas");

  try {
    await QRCode.toCanvas(
      canvas,
      `BIN:${bin.name}:${bin.room || "General"}`,
      {
        width: 190,
        margin: 2,
        color: {
          dark: "#153d2b",
          light: "#ffffff"
        }
      }
    );

    $("qrOutput").append(canvas);

    const label = document.createElement("div");
    label.textContent = `${bin.name} · ${bin.room || "General"}`;
    label.style.cssText =
      "font-weight:700;text-align:center;margin-top:8px";

    $("qrOutput").append(label);
  } catch (error) {
    console.error(error);
  }
}

$("downloadBinQr").addEventListener("click", () => {
  const canvas = $("qrOutput").querySelector("canvas");

  if (!canvas) {
    alert("Generate a QR code first.");
    return;
  }

  const bin =
    state.bins.find(item => item.id === $("qrBinSelect").value) ||
    state.bins[0];

  const output = document.createElement("canvas");
  output.width = canvas.width + 40;
  output.height = canvas.height + 95;

  const context = output.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(canvas, 20, 12);

  context.fillStyle = "#153d2b";
  context.textAlign = "center";
  context.font = "bold 15px sans-serif";
  context.fillText(bin.name, output.width / 2, canvas.height + 43);

  context.font = "12px sans-serif";
  context.fillText(
    bin.room || "General",
    output.width / 2,
    canvas.height + 65
  );

  const link = document.createElement("a");
  link.href = output.toDataURL("image/png");
  link.download = `bin-${safeId(bin.name)}-qr.png`;
  link.click();
});

// Analytics and leaderboard
function renderAnalytics() {
  if (!$("leaderboardRows")) return;

  const filter = ($("analyticsFilter")?.value || "")
    .toLowerCase()
    .trim();

  const users = {};

  state.records
    .filter(record =>
      !filter ||
      `${record.department} ${record.room}`.toLowerCase().includes(filter)
    )
    .forEach(record => {
      const user = users[record.userId] ||
        (users[record.userId] = {
          username: record.username || record.userId,
          role: record.role || "Student",
          department: record.department || "Unassigned",
          items: 0,
          correct: 0,
          points: 0
        });

      user.items++;

      if (record.correct) user.correct++;
      user.points += record.points || 0;
    });

  const list = Object.values(users).sort((a, b) => b.points - a.points);

  const filteredRecords = state.records.filter(record =>
    !filter ||
    `${record.department} ${record.room}`.toLowerCase().includes(filter)
  );

  $("adminMetrics").innerHTML = [
    ["Items logged", filteredRecords.length],
    [
      "Sorting accuracy",
      filteredRecords.length
        ? Math.round(
            filteredRecords.filter(record => record.correct).length /
            filteredRecords.length * 100
          ) + "%"
        : "—"
    ],
    ["Active profiles", list.length]
  ].map(([label, value]) => `
    <div class="admin-metric">
      <small>${label}</small>
      <strong>${value}</strong>
    </div>
  `).join("");

  $("leaderboardRows").innerHTML = list.length
    ? list.map(user => `
      <tr>
        <td>@${escapeHtml(user.username)}</td>
        <td>${escapeHtml(user.role)}</td>
        <td>${escapeHtml(user.department)}</td>
        <td>${user.items}</td>
        <td>${user.items ? Math.round(user.correct / user.items * 100) : 0}%</td>
        <td>${user.points}</td>
      </tr>
    `).join("")
    : '<tr><td colspan="6" class="empty">No matching activity.</td></tr>';

  $("adminUserList").innerHTML =
    Object.values(state.users).map(user => `
      <div class="admin-list-item">
        <div>
          <strong>@${escapeHtml(user.username || "unknown")}</strong>
          <small>${escapeHtml(user.role || "Student")} · ${escapeHtml(user.department || "Unassigned")}</small>
        </div>
        <span>
          ${state.records.filter(record =>
            record.userId === safeId(user.username)
          ).length} logs
        </span>
      </div>
    `).join("") ||
    '<p class="helper">No profiles yet.</p>';
}

$("analyticsFilter").addEventListener("input", renderAnalytics);

$("exportAll").addEventListener("click", () => {
  downloadCsv("ecosort-research-data.csv", state.records);
});

$("clearLocal").addEventListener("click", () => {
  if (!adminUnlocked) return;

  if (!confirm("Clear all locally stored EcoSort records and profiles? This cannot be undone.")) {
    return;
  }

  state.records = [];
  state.users = {};
  persist();
  syncClear();
  renderAnalytics();
  alert("Local activity data cleared.");
});

// Export records to CSV
function downloadCsv(filename, records) {
  const columns = [
    "timestamp",
    "username",
    "role",
    "department",
    "item",
    "expectedCategory",
    "binName",
    "binCategory",
    "room",
    "correct",
    "points"
  ];

  const quote = value =>
    `"${String(value ?? "").replace(/"/g, '""')}"`;

  const csv = [
    columns.join(","),
    ...records.map(record =>
      columns.map(key => {
        const value = key === "timestamp"
          ? new Date(record[key]).toISOString()
          : record[key];

        return quote(value)
          .replace(/^"true"$/, "true")
          .replace(/^"false"$/, "false");
      }).join(",")
    )
  ].join("\r\n");

  const blob = new Blob(["\ufeff" + csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

// Camera and AI object detection
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showStatus(
      "disposalStatus",
      "Camera access is unavailable. Use manual selection instead."
    );
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });

    $("camera").srcObject = stream;
    $("cameraStage").classList.add("live");
    $("startCamera").disabled = true;
    $("stopCamera").disabled = false;
    $("cameraPlaceholder").classList.add("hidden");

    $("cameraLabel").classList.remove("hidden");
    $("cameraLabel").textContent = "Loading AI model…";

    if (!model) {
      model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
    }

    $("cameraLabel").textContent = "AI active · point at one item";
    cameraTimer = setInterval(detectFrame, 1400);
  } catch (error) {
    console.error(error);

    showStatus(
      "disposalStatus",
      "Camera permission failed or camera is unavailable. You can still use manual selection."
    );

    stopCamera();
  }
}

async function detectFrame() {
  if (!model || !stream || $("camera").readyState < 2) return;

  try {
    const predictions = await model.detect($("camera"));
    if (!predictions.length) return;

    predictions.sort((a, b) => b.score - a.score);

    const prediction = predictions[0];
    const label = COCO_MAP[prediction.class] || "other / unlisted item";

    $("cameraLabel").textContent =
      `${prediction.class.replaceAll("_", " ")} · ${Math.round(prediction.score * 100)}%`;

    if (prediction.score >= 0.58) {
      selectWaste(label, "ai");
    }
  } catch (error) {
    console.warn("Detection skipped", error);
  }
}

function stopCamera() {
  if (cameraTimer) clearInterval(cameraTimer);
  cameraTimer = null;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }

  stream = null;

  if ($("camera")) $("camera").srcObject = null;
  $("cameraStage").classList.remove("live");
  $("cameraPlaceholder").classList.remove("hidden");
  $("cameraLabel").classList.add("hidden");
  $("startCamera").disabled = false;
  $("stopCamera").disabled = true;
}

$("startCamera").addEventListener("click", startCamera);
$("stopCamera").addEventListener("click", stopCamera);
window.addEventListener("beforeunload", stopCamera);

// Firebase Realtime Database
async function initFirebase() {
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);

    const connected = await get(ref(db, ".info/connected"));
    firebaseReady = connected.exists();

    onValue(ref(db, ".info/connected"), snapshot => {
      firebaseReady = !!snapshot.val();
      setConnection();
    });

    onValue(
      ref(db, "ecosort/bins"),
      snapshot => {
        const remote = snapshot.val();

        if (
          remote &&
          typeof remote === "object" &&
          Object.keys(remote).length
        ) {
          state.bins = Object.values(remote);
          localStorage.setItem(STORE_KEY, JSON.stringify(state));
          renderBins();
        }
      },
      error => {
        console.warn(
          "Firebase bin sync unavailable; local mode remains active.",
          error.message
        );
      }
    );

    onValue(
      ref(db, "ecosort/records"),
      snapshot => {
        const remote = snapshot.val();

        if (remote && typeof remote === "object") {
          const map = new Map(state.records.map(record => [record.id, record]));

          Object.values(remote).forEach(record => {
            if (record?.id) map.set(record.id, record);
          });

          state.records = [...map.values()];
          localStorage.setItem(STORE_KEY, JSON.stringify(state));
          updateUI();
        }
      },
      error => {
        console.warn(
          "Firebase record sync unavailable; local mode remains active.",
          error.message
        );
      }
    );
  } catch (error) {
    firebaseReady = false;
    console.warn("Firebase unavailable; local-first mode:", error.message);
    setConnection();
  }
}

async function syncProfile() {
  if (!db || !state.profile) return;

  try {
    await set(
      ref(db, `ecosort/users/${safeId(state.profile.username)}`),
      state.profile
    );
  } catch (error) {
    console.warn("Profile sync blocked by database rules.", error.message);
  }
}

async function syncRecord(record) {
  if (!db) return;

  try {
    await set(ref(db, `ecosort/records/${record.id}`), record);
  } catch (error) {
    console.warn(
      "Record sync blocked by database rules; kept locally.",
      error.message
    );
  }
}

async function syncBins() {
  if (!db) return;

  try {
    await set(
      ref(db, "ecosort/bins"),
      Object.fromEntries(state.bins.map(bin => [bin.id, bin]))
    );
  } catch (error) {
    console.warn("Bin sync blocked by database rules.", error.message);
  }
}

async function syncClear() {
  if (!db) return;

  try {
    await set(ref(db, "ecosort/records"), {});
    await set(ref(db, "ecosort/users"), {});
  } catch (error) {
    console.warn("Remote maintenance blocked by database rules.", error.message);
  }
}

// Initialize the application
function init() {
  renderBins();
  updateUI();
  initFirebase();

  if (
    !("serviceWorker" in navigator) ||
    location.protocol === "file:"
  ) {
    return;
  }

  navigator.serviceWorker.register("./sw.js").catch(error => {
    console.warn("Service worker not registered", error);
  });
}

init();

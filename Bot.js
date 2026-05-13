const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');

// ===== 1. CONFIGURATION =====
const TOKEN        = "8692459169:AAGlQsbCDcva-r_b89xPA9QuiGzgWDjX2h4";
const OWNER_ID     = 8321379592;
const OWNER_PASS   = "suthamari6381";
const ADMIN_HANDLE = "@Tamilan12345678";
const REG_LINK     = "https://www.goaoko.com/#/register?invitationCode=457367799017";

const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

let AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOiIxNzc4MjIyOTUwIn0.placeholder";

// ===== 2. DATA STORAGE =====
let ownerLoggedIn  = false;             // owner session
let admins         = {};                // { adminId: { password, loggedIn, name } }
let adminPasswords = {};                // { adminId: "password" }
let adminLoggedIn  = {};                // { adminId: true/false }
let usersAccess    = {};                // { userId: expiryTimestamp }
let stats          = {};                // per-user stats
let running        = {};                // prediction loop active
let sentPeriods    = {};                // duplicate prevention
let keyStore       = {};                // { "KING-XXXX": { days, used, usedBy, createdAt, createdByAdmin } }

// State machines
let ownerState     = {};
let adminStateMap  = {};
let tempState      = {};

// ===== 3. HELPER FUNCTIONS =====
function initUser(userId) {
    if (!stats[userId]) {
        stats[userId] = { total:0, win:0, loss:0, lossStreak:0, winStreak:0, maxWinStreak:0, maxLossStreak:0 };
    }
    if (!sentPeriods[userId]) sentPeriods[userId] = new Set();
}

function hasAccess(userId) {
    return usersAccess[userId] && Date.now() < usersAccess[userId];
}

function daysLeft(userId) {
    if (!usersAccess[userId]) return "0";
    return ((usersAccess[userId] - Date.now()) / 86400000).toFixed(1);
}

function isAdmin(userId) {
    return adminPasswords[userId] !== undefined;
}

function isAdminLoggedIn(userId) {
    return adminLoggedIn[userId] === true;
}

function isOwner(userId) {
    return userId === OWNER_ID;
}

function isOwnerLoggedIn() {
    return ownerLoggedIn;
}

// Generate key
function generateKey(days, adminId) {
    const key = "KING-" + crypto.randomBytes(3).toString('hex').toUpperCase() + "-" + crypto.randomBytes(2).toString('hex').toUpperCase();
    keyStore[key] = { days, used: false, usedBy: null, createdAt: Date.now(), createdByAdmin: adminId || OWNER_ID };
    return key;
}

// Activate key
function activateKey(userId, keyCode) {
    const key = keyCode.toUpperCase().trim();
    if (!keyStore[key])        return { ok: false, reason: "Invalid key! Check and try again." };
    if (keyStore[key].used)    return { ok: false, reason: "This key is already used!" };
    const days = keyStore[key].days;
    keyStore[key].used   = true;
    keyStore[key].usedBy = userId;
    const base = (usersAccess[userId] && usersAccess[userId] > Date.now()) ? usersAccess[userId] : Date.now();
    usersAccess[userId]  = base + days * 86400000;
    return { ok: true, days, expiry: new Date(usersAccess[userId]).toLocaleString() };
}

function listActiveUsers() {
    const now = Date.now();
    const list = Object.entries(usersAccess).filter(([,exp]) => exp > now);
    if (!list.length) return "No active users.";
    return list.map(([id, exp]) => {
        const d = ((exp - now)/86400000).toFixed(1);
        return "ID: " + id + " | " + d + " days left";
    }).join("\n");
}

function listAdmins() {
    const ids = Object.keys(adminPasswords);
    if (!ids.length) return "No admins added.";
    return ids.map(id => {
        const status = adminLoggedIn[id] ? "Online" : "Offline";
        return "Admin ID: " + id + " | " + status;
    }).join("\n");
}

function listAllKeys() {
    const keys = Object.entries(keyStore);
    if (!keys.length) return "No keys yet.";
    return keys.map(([k, v]) => {
        const status = v.used ? "Used by " + v.usedBy : "Available (" + v.days + "d)";
        return k + " - " + status;
    }).join("\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 4. BOT INIT =====
let bot;
function createBot() {
    if (bot) { try { bot.stopPolling(); } catch(e){} }
    bot = new TelegramBot(TOKEN, {
        polling: { interval: 1000, autoStart: true, params: { timeout: 30 } }
    });
    bot.on("polling_error", (err) => {
        console.error("Polling error:", err.code, err.message);
        setTimeout(createBot, 5000);
    });
    bot.on("error", (err) => { console.error("Bot error:", err.message); });
    registerHandlers();
    console.log("Bot started.");
}

// ===== 5. KEYBOARDS =====
function getMenu(userId) {
    const rows = [
        ["Start Prediction"],
        ["Result", "Contact"],
        ["Stop Bot"]
    ];
    // Show Admin Panel button only for admins (owner uses /owner command)
    if (isAdmin(userId) && !isOwner(userId)) {
        rows.push(["Admin Panel"]);
    }
    return { keyboard: rows, resize_keyboard: true };
}

function getAdminMenu() {
    return {
        keyboard: [
            ["Active Users", "Generate Key"],
            ["Add User", "Remove User"],
            ["All Keys", "Admin Logout"]
        ],
        resize_keyboard: true
    };
}

function getOwnerMenu() {
    return {
        keyboard: [
            ["All Users", "All Admins"],
            ["Add Admin", "Remove Admin"],
            ["Generate Key", "All Keys"],
            ["Add User", "Remove User"],
            ["Set Token", "Owner Logout"]
        ],
        resize_keyboard: true
    };
}

// ===== 6. SAFE SEND — NO MARKDOWN to avoid parse errors =====
async function safeSend(chatId, text, opts = {}) {
    try {
        return await bot.sendMessage(chatId, text, opts);
    } catch(e) {
        // Retry without parse_mode if markdown error
        if (e.message && e.message.includes("parse entities")) {
            try {
                const safeOpts = Object.assign({}, opts);
                delete safeOpts.parse_mode;
                return await bot.sendMessage(chatId, text, safeOpts);
            } catch(e2) { console.error("sendMessage retry failed:", e2.message); }
        } else {
            console.error("sendMessage:", e.message);
        }
    }
}
async function safeSticker(chatId, sid) {
    try { return await bot.sendSticker(chatId, sid); }
    catch(e) { console.error("sendSticker:", e.message); }
}

// ===== 7. FETCH DATA =====
async function fetchData(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await axios.get(
                "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?ts=" + Date.now(),
                {
                    headers: {
                        "Authorization": "Bearer " + AUTH_TOKEN,
                        "User-Agent": "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36",
                        "Accept": "application/json, text/plain, */*",
                        "Accept-Encoding": "gzip, deflate, br",
                        "Accept-Language": "en-US,en;q=0.9",
                        "Origin": "https://www.goaoko.com",
                        "Referer": "https://www.goaoko.com/"
                    },
                    timeout: 10000,
                    decompress: true
                }
            );
            
            // Handle different response formats
            let data = res.data;
            if (typeof data === "string") {
                try { data = JSON.parse(data); } catch(e) {}
            }
            
            const list = data && data.data && data.data.list;
            if (list && list.length > 0) return list;
            
            if (data && (data.code === 401 || (data.msg && data.msg.toLowerCase().includes("token")))) {
                safeSend(OWNER_ID, "AUTH TOKEN EXPIRED! Use Set Token in Owner Panel.");
                return null;
            }
            
            console.log("API response:", JSON.stringify(data).slice(0, 200));
        } catch(e) {
            console.error("Fetch attempt " + (i+1) + " failed:", e.message);
            if (i < retries - 1) await sleep(3000);
        }
    }
    return null;
}

// ===== 8. PREDICTION =====
function getLevelInfo(lossStreak) {
    const level  = Math.min(lossStreak + 1, 5);
    const stars  = "★".repeat(level) + "☆".repeat(5 - level);
    const labels = ["", "LEVEL 1 SURE", "LEVEL 2 SURE", "LEVEL 3 SURE", "LEVEL 4 SURE", "LEVEL 5 SURE"];
    return { level, stars, label: labels[level] };
}

function predict(list, userStats) {
    const results = list.slice(0, 10).map(i => parseInt(i.number) >= 5 ? "BIG" : "SMALL");
    const last5   = results.slice(0, 5);
    const last10  = results.slice(0, 10);
    const big5    = last5.filter(x => x === "BIG").length;
    const big10   = last10.filter(x => x === "BIG").length;

    let pred = big5 >= 3 ? "BIG" : "SMALL";

    let streak = 1;
    for (let i = 1; i < last5.length; i++) {
        if (last5[i] === last5[0]) streak++; else break;
    }
    if (streak >= 3) pred = last5[0] === "BIG" ? "SMALL" : "BIG";

    const ls = userStats.lossStreak;
    if (ls === 1) pred = big10 >= 5 ? "BIG" : "SMALL";
    if (ls === 2) pred = last5[0] === "BIG" ? "SMALL" : "BIG";
    if (ls === 3) pred = big5 >= 3 ? "BIG" : "SMALL";
    if (ls >= 4)  pred = big10 >= 6 ? "BIG" : "SMALL";

    return pred;
}

// ===== 9. PREDICT LOOP =====
async function runPredict(userId, chatId) {
    if (!running[userId]) return;

    const list = await fetchData();
    if (!list) {
        await safeSend(chatId, "API error, retrying in 10s...");
        return setTimeout(() => runPredict(userId, chatId), 10000);
    }

    const nextPeriod = (BigInt(list[0].issueNumber) + 1n).toString();

    if (!sentPeriods[userId]) sentPeriods[userId] = new Set();
    if (sentPeriods[userId].has(nextPeriod)) {
        return setTimeout(() => runPredict(userId, chatId), 5000);
    }
    sentPeriods[userId].add(nextPeriod);
    if (sentPeriods[userId].size > 20) {
        const arr = [...sentPeriods[userId]];
        sentPeriods[userId] = new Set(arr.slice(-20));
    }

    const pred = predict(list, stats[userId]);
    const lvl  = getLevelInfo(stats[userId].lossStreak);
    const emoji = pred === "BIG" ? "🔴" : "🔵";
    const arrow = pred === "BIG" ? "BIG" : "SMALL";
    const msg = (
        "📊 AR-LOTTERY SIGNAL\n" +
        "〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n" +
        "📅 Period : " + nextPeriod + "\n" +
        "🎯 Predict: " + emoji + " " + arrow + "\n" +
        "📈 Signal : " + lvl.label + "\n" +
        "⭐ Level  : " + lvl.stars + "\n" +
        "〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n" +
        "⚡ Place your bet NOW!"
    );

    await safeSend(chatId, msg, {
        reply_markup: {
            inline_keyboard: [[{ text: "BET NOW - GOAOKO", url: REG_LINK }]]
        }
    });

    checkResult(userId, chatId, nextPeriod, pred);
}

// ===== 10. RESULT CHECKER =====
async function checkResult(userId, chatId, targetPeriod, predicted) {
    let attempts = 0;
    const iv = setInterval(async () => {
        if (!running[userId]) return clearInterval(iv);
        if (++attempts > 18) {
            clearInterval(iv);
            await safeSend(chatId, "Result timeout - moving to next period.");
            setTimeout(() => { if (running[userId]) runPredict(userId, chatId); }, 3000);
            return;
        }
        const list = await fetchData();
        if (!list) return;
        if (BigInt(list[0].issueNumber) < BigInt(targetPeriod)) return;

        clearInterval(iv);
        const resData   = list.find(i => i.issueNumber === targetPeriod) || list[0];
        const actualNum = parseInt(resData.number);
        const actual    = actualNum >= 5 ? "BIG" : "SMALL";
        const win       = predicted === actual;
        const s         = stats[userId];

        s.total++;
        if (win) {
            s.win++; s.winStreak++; s.lossStreak = 0;
            if (s.winStreak > s.maxWinStreak) s.maxWinStreak = s.winStreak;
            await safeSend(chatId, "✅ WIN! 🎉\n🔢 Number: " + actualNum + " ➡️ " + actual + "\n🔥 Win Streak: " + s.winStreak + "\n💰 Keep Betting!");
            await safeSticker(chatId, WIN_STICKER);
        } else {
            s.loss++; s.lossStreak++; s.winStreak = 0;
            if (s.lossStreak > s.maxLossStreak) s.maxLossStreak = s.lossStreak;
            const next = getLevelInfo(s.lossStreak);
            await safeSend(chatId, "❌ LOSS\n🔢 Number: " + actualNum + " ➡️ " + actual + "\n⚠️ Next Signal: " + next.label + " " + next.stars + "\n💪 Stay Strong!");
            await safeSticker(chatId, LOSS_STICKER);
        }
        setTimeout(() => { if (running[userId]) runPredict(userId, chatId); }, 8000);
    }, 10000);
}

// ===== 11. STATS =====
function showStats(msg) {
    const d    = stats[msg.from.id];
    const rate = d.total ? ((d.win / d.total) * 100).toFixed(1) : "0.0";
    const fill = d.total ? Math.round(d.win / d.total * 10) : 0;
    const bar  = "W".repeat(fill) + "L".repeat(10 - fill);
    safeSend(msg.chat.id,
        "📊 PERFORMANCE REPORT\n" +
        "〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n" +
        "🔮 Total    : " + d.total + "\n" +
        "✅ Wins     : " + d.win + "\n" +
        "❌ Losses   : " + d.loss + "\n" +
        "📈 Accuracy : " + rate + "%\n" +
        "[" + bar + "]\n" +
        "〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n" +
        "🔥 Best Win Streak  : " + d.maxWinStreak + "\n" +
        "💀 Worst Loss Streak: " + d.maxLossStreak
    );
}

// ===== 12. HANDLERS =====
function registerHandlers() {

    // ===== /owner command =====
    bot.onText(/\/owner/, (msg) => {
        if (!isOwner(msg.from.id)) return;
        if (isOwnerLoggedIn()) {
            return safeSend(OWNER_ID, "Already logged in! Use Owner Panel buttons.", { reply_markup: getOwnerMenu() });
        }
        ownerState[OWNER_ID] = { action: "login" };
        safeSend(OWNER_ID, "Enter owner password:");
    });

    // ===== /start =====
    bot.onText(/\/start/, (msg) => {
        const userId = msg.from.id;
        initUser(userId);
        const status = hasAccess(userId) ? "ACTIVE - " + daysLeft(userId) + " days left" : "NO ACCESS";
        safeSend(msg.chat.id,
            "👑 AR-LOTTERY PREDICTION BOT\n\n" +
            "📌 Status  : " + status + "\n" +
            "🆔 Your ID : " + userId + "\n" +
            "📩 Contact : " + ADMIN_HANDLE + "\n\n" +
            "🔑 Have a key? Type: /key YOURCODE",
            { reply_markup: getMenu(userId) }
        );
    });

    // ===== /key CODE =====
    bot.onText(/\/key (.+)/, (msg, match) => {
        const userId  = msg.from.id;
        const keyCode = match[1].trim();
        initUser(userId);
        const result = activateKey(userId, keyCode);
        if (result.ok) {
            safeSend(msg.chat.id,
                "🎊 KEY ACTIVATED!\n\n" +
                "⏳ Duration : " + result.days + " days\n" +
                "📅 Expires  : " + result.expiry + "\n\n" +
                "👇 Tap Start Prediction to begin!",
                { reply_markup: getMenu(userId) }
            );
            safeSend(OWNER_ID, "Key Activated!\nUser: " + userId + "\nKey: " + keyCode + "\nDays: " + result.days);
            // Also notify all logged-in admins
            Object.keys(adminLoggedIn).forEach(adminId => {
                if (adminLoggedIn[adminId]) {
                    safeSend(parseInt(adminId), "Key Activated!\nUser: " + userId + "\nKey: " + keyCode + "\nDays: " + result.days);
                }
            });
        } else {
            safeSend(msg.chat.id, result.reason);
        }
    });

    // ===== /adminlogin PASSWORD (for admins) =====
    bot.onText(/\/adminlogin (.+)/, (msg, match) => {
        const userId = msg.from.id;
        if (!isAdmin(userId)) return safeSend(userId, "You are not an admin.");
        const entered = match[1].trim();
        if (entered === adminPasswords[userId]) {
            adminLoggedIn[userId] = true;
            safeSend(userId, "Admin Login Success!\n\nUse the Admin Panel buttons.", { reply_markup: getAdminMenu() });
        } else {
            safeSend(userId, "Wrong password!");
        }
    });

    // ===== Main message handler =====
    bot.on("message", async (msg) => {
        const userId = msg.from.id;
        const text   = msg.text;
        if (!text || text.startsWith("/")) return;
        initUser(userId);

        // ══════════════════════════════
        // OWNER STATE MACHINE
        // ══════════════════════════════
        if (isOwner(userId) && ownerState[OWNER_ID]) {
            const state = ownerState[OWNER_ID];

            if (text === "Owner Logout") {
                ownerLoggedIn = false;
                delete ownerState[OWNER_ID];
                return safeSend(OWNER_ID, "Owner logged out.", { reply_markup: getMenu(userId) });
            }

            // Login
            if (state.action === "login") {
                if (text === OWNER_PASS) {
                    ownerLoggedIn = true;
                    delete ownerState[OWNER_ID];
                    return safeSend(OWNER_ID, "👑 Owner Login Success! Welcome Boss.", { reply_markup: getOwnerMenu() });
                } else {
                    return safeSend(OWNER_ID, "Wrong password!");
                }
            }

            // Add Admin - step 1: get ID
            if (state.action === "addadmin") {
                if (!state.adminId) {
                    const id = parseInt(text.trim());
                    if (isNaN(id)) return safeSend(OWNER_ID, "Invalid ID. Send valid user ID:");
                    state.adminId = id;
                    return safeSend(OWNER_ID, "ID: " + id + "\nNow set a password for this admin:");
                } else {
                    const pass = text.trim();
                    const newAdminId = state.adminId;
                    // Validate password strength
                    if (pass.length < 6) {
                        state.adminId = newAdminId; // keep state
                        return safeSend(OWNER_ID, "Password too short! Min 6 characters. Set a stronger password:");
                    }
                    adminPasswords[newAdminId] = pass;
                    adminLoggedIn[newAdminId]  = false;
                    delete ownerState[OWNER_ID];
                    safeSend(OWNER_ID,
                        "Admin added!\nID: " + newAdminId + "\nPassword: " + pass + "\n\nTell them:\n1. Open bot\n2. Type: /adminlogin " + pass + "\n3. Use Admin Panel button",
                        { reply_markup: getOwnerMenu() }
                    );
                    // Send admin their credentials + make bot show Admin Panel button
                    safeSend(newAdminId,
                        "You have been added as Admin!\n\nYour password: " + pass + "\n\nLogin: /adminlogin " + pass + "\n\nAfter login, Admin Panel button will appear at bottom."
                    );
                    return;
                }
            }

            // Remove Admin
            if (state.action === "removeadmin") {
                const id = parseInt(text.trim());
                if (isNaN(id)) return safeSend(OWNER_ID, "Invalid ID:");
                if (!adminPasswords[id]) {
                    delete ownerState[OWNER_ID];
                    return safeSend(OWNER_ID, "This ID is not an admin.", { reply_markup: getOwnerMenu() });
                }
                delete adminPasswords[id];
                delete adminLoggedIn[id];
                delete ownerState[OWNER_ID];
                safeSend(OWNER_ID, "Admin " + id + " removed.", { reply_markup: getOwnerMenu() });
                safeSend(id, "Your admin access has been removed.");
                return;
            }

            // Generate Key
            if (state.action === "genkey") {
                const days = parseInt(text.trim());
                if (isNaN(days) || days < 1) return safeSend(OWNER_ID, "Invalid. Enter number of days:");
                const key = generateKey(days, OWNER_ID);
                delete ownerState[OWNER_ID];
                return safeSend(OWNER_ID,
                    "Key Generated!\n\n" + key + "\n\nValid: " + days + " days\nUser types: /key " + key,
                    { reply_markup: getOwnerMenu() }
                );
            }

            // Add User
            if (state.action === "adduser") {
                if (!state.targetId) {
                    const id = parseInt(text.trim());
                    if (isNaN(id)) return safeSend(OWNER_ID, "Invalid ID:");
                    state.targetId = id;
                    return safeSend(OWNER_ID, "ID: " + id + "\nHow many days?");
                } else {
                    const days = parseInt(text.trim());
                    if (isNaN(days) || days < 1) return safeSend(OWNER_ID, "Invalid days:");
                    const tid = state.targetId;
                    usersAccess[tid] = Date.now() + days * 86400000;
                    delete ownerState[OWNER_ID];
                    safeSend(OWNER_ID, "User " + tid + " activated for " + days + " days.", { reply_markup: getOwnerMenu() });
                    safeSend(tid, "VIP ACCESS ACTIVATED! " + days + " days.\nTap Start Prediction to begin!");
                    return;
                }
            }

            // Remove User
            if (state.action === "removeuser") {
                const id = parseInt(text.trim());
                if (isNaN(id)) return safeSend(OWNER_ID, "Invalid ID:");
                const was = hasAccess(id);
                delete usersAccess[id];
                running[id] = false;
                delete ownerState[OWNER_ID];
                safeSend(OWNER_ID, was ? "User " + id + " removed." : "User " + id + " was not active.", { reply_markup: getOwnerMenu() });
                if (was) safeSend(id, "Your access has been removed. Contact admin.");
                return;
            }

            // Set Token
            if (state.action === "settoken") {
                AUTH_TOKEN = text.trim();
                delete ownerState[OWNER_ID];
                return safeSend(OWNER_ID, "Auth token updated!", { reply_markup: getOwnerMenu() });
            }
        }

        // ══════════════════════════════
        // OWNER MENU BUTTONS
        // ══════════════════════════════
        if (isOwner(userId) && isOwnerLoggedIn()) {
            if (text === "All Users") {
                return safeSend(OWNER_ID, "Active Users:\n\n" + listActiveUsers());
            }
            if (text === "All Admins") {
                return safeSend(OWNER_ID, "Admins:\n\n" + listAdmins());
            }
            if (text === "Add Admin") {
                ownerState[OWNER_ID] = { action: "addadmin" };
                return safeSend(OWNER_ID, "Send the User ID to make admin:");
            }
            if (text === "Remove Admin") {
                ownerState[OWNER_ID] = { action: "removeadmin" };
                return safeSend(OWNER_ID, "Send the Admin ID to remove:");
            }
            if (text === "Generate Key") {
                ownerState[OWNER_ID] = { action: "genkey" };
                return safeSend(OWNER_ID, "How many days should the key be valid?");
            }
            if (text === "All Keys") {
                return safeSend(OWNER_ID, "All Keys:\n\n" + listAllKeys());
            }
            if (text === "Add User") {
                ownerState[OWNER_ID] = { action: "adduser" };
                return safeSend(OWNER_ID, "Send the User ID to activate:");
            }
            if (text === "Remove User") {
                ownerState[OWNER_ID] = { action: "removeuser" };
                return safeSend(OWNER_ID, "Send the User ID to remove:");
            }
            if (text === "Set Token") {
                ownerState[OWNER_ID] = { action: "settoken" };
                return safeSend(OWNER_ID, "Paste the new Auth Token:");
            }
            if (text === "Owner Logout") {
                ownerLoggedIn = false;
                return safeSend(OWNER_ID, "Owner logged out.", { reply_markup: getMenu(userId) });
            }
        }

        // ══════════════════════════════
        // ADMIN STATE MACHINE
        // ══════════════════════════════
        if (isAdmin(userId) && isAdminLoggedIn(userId) && adminStateMap[userId]) {
            const state = adminStateMap[userId];

            if (text === "Admin Logout") {
                adminLoggedIn[userId] = false;
                delete adminStateMap[userId];
                return safeSend(userId, "Admin logged out.", { reply_markup: getMenu(userId) });
            }

            if (state.action === "genkey") {
                const days = parseInt(text.trim());
                if (isNaN(days) || days < 1) return safeSend(userId, "Invalid. Enter number of days:");
                const key = generateKey(days, userId);
                delete adminStateMap[userId];
                return safeSend(userId,
                    "Key Generated!\n\n" + key + "\n\nValid: " + days + " days\nUser types: /key " + key,
                    { reply_markup: getAdminMenu() }
                );
            }

            if (state.action === "adduser") {
                if (!state.targetId) {
                    const id = parseInt(text.trim());
                    if (isNaN(id)) return safeSend(userId, "Invalid ID:");
                    state.targetId = id;
                    return safeSend(userId, "ID: " + id + "\nHow many days?");
                } else {
                    const days = parseInt(text.trim());
                    if (isNaN(days) || days < 1) return safeSend(userId, "Invalid days:");
                    const tid = state.targetId;
                    usersAccess[tid] = Date.now() + days * 86400000;
                    delete adminStateMap[userId];
                    safeSend(userId, "User " + tid + " activated for " + days + " days.", { reply_markup: getAdminMenu() });
                    safeSend(tid, "VIP ACCESS ACTIVATED! " + days + " days.\nTap Start Prediction to begin!");
                    return;
                }
            }

            if (state.action === "removeuser") {
                const id = parseInt(text.trim());
                if (isNaN(id)) return safeSend(userId, "Invalid ID:");
                const was = hasAccess(id);
                delete usersAccess[id];
                running[id] = false;
                delete adminStateMap[userId];
                safeSend(userId, was ? "User " + id + " removed." : "User " + id + " was not active.", { reply_markup: getAdminMenu() });
                if (was) safeSend(id, "Your access has been removed. Contact admin.");
                return;
            }
        }

        // ══════════════════════════════
        // ADMIN MENU BUTTONS
        // ══════════════════════════════
        if (isAdmin(userId) && isAdminLoggedIn(userId)) {
            if (text === "Active Users") {
                return safeSend(userId, "Active Users:\n\n" + listActiveUsers());
            }
            if (text === "Generate Key") {
                adminStateMap[userId] = { action: "genkey" };
                return safeSend(userId, "How many days should the key be valid?");
            }
            if (text === "Add User") {
                adminStateMap[userId] = { action: "adduser" };
                return safeSend(userId, "Send the User ID to activate:");
            }
            if (text === "Remove User") {
                adminStateMap[userId] = { action: "removeuser" };
                return safeSend(userId, "Send the User ID to remove:");
            }
            if (text === "All Keys") {
                return safeSend(userId, "All Keys:\n\n" + listAllKeys());
            }
            if (text === "Admin Logout") {
                adminLoggedIn[userId] = false;
                return safeSend(userId, "Admin logged out.", { reply_markup: getMenu(userId) });
            }
        }

        // ══════════════════════════════
        // USER BUTTONS
        // ══════════════════════════════
        if (text === "Start Prediction") {
            if (!hasAccess(userId)) {
                return safeSend(msg.chat.id,
                    "❌ Access Denied!\n\n📩 Contact " + ADMIN_HANDLE + " for key.\n🆔 Your ID: " + userId + "\n\n🔑 Have a key? Type: /key YOURCODE"
                );
            }
            if (running[userId]) return safeSend(msg.chat.id, "Already running! Tap Stop Bot first.");
            running[userId] = true;
            sentPeriods[userId] = new Set();
            await safeSend(msg.chat.id, "🚀 PREDICTION ENGINE ACTIVATED!\n⏳ Fetching next period...");
            runPredict(userId, msg.chat.id);
        }

        if (text === "Stop Bot") {
            running[userId] = false;
            safeSend(msg.chat.id, "Prediction stopped.");
        }

        if (text === "Result") showStats(msg);

        if (text === "Contact") {
            safeSend(msg.chat.id,
                "📩 Contact Admin\n\n🔗 Handle : " + ADMIN_HANDLE + "\n🆔 Your ID: " + userId + "\n\n💬 Send your ID to admin for key."
            );
        }

        // Admin Panel button (shown only to admins)
        if (text === "Admin Panel" && isAdmin(userId) && !isOwner(userId)) {
            if (!isAdminLoggedIn(userId)) {
                return safeSend(userId,
                    "Admin Login Required!\n\nType: /adminlogin YOUR_PASSWORD"
                );
            }
            return safeSend(userId,
                "Admin Panel\n\nChoose action:",
                { reply_markup: getAdminMenu() }
            );
        }
    });
}

// ===== START =====
createBot();
console.log("AR-LOTTERY BOT running...");

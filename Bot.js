const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');
const zlib        = require('zlib');

// ============================================================
//  CONFIG
// ============================================================
const BOT_TOKEN    = "8692459169:AAGlQsbCDcva-r_b89xPA9QuiGzgWDjX2h4";
const OWNER_ID     = 8321379592;
const OWNER_PASS   = "suthamari6381";
const ADMIN_HANDLE = "@Tamilan12345678";
const REG_LINK     = "https://www.goaoko.com/#/register?invitationCode=457367799017";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

// ============================================================
//  STORAGE
// ============================================================
let ownerLoggedIn  = false;
let adminPasswords = {};   // { userId: "password" }
let adminLoggedIn  = {};   // { userId: true/false }
let usersAccess    = {};   // { userId: expiryTimestamp }
let keyStore       = {};   // { "KING-XXX": { days, used, usedBy } }
let stats          = {};   // { userId: { total, win, loss, ... } }
let running        = {};   // { userId: true/false }
let sentPeriods    = {};   // { userId: Set<period> }
let ownerState     = null; // current owner input state
let adminState     = {};   // { userId: state }

// ============================================================
//  HELPERS
// ============================================================
function initUser(id) {
    if (!stats[id])       stats[id]       = { total:0, win:0, loss:0, lossStreak:0, winStreak:0, maxWinStreak:0, maxLossStreak:0 };
    if (!sentPeriods[id]) sentPeriods[id] = new Set();
}
function hasAccess(id)  { return !!(usersAccess[id] && Date.now() < usersAccess[id]); }
function daysLeft(id)   { return usersAccess[id] ? ((usersAccess[id]-Date.now())/86400000).toFixed(1) : "0"; }
function isAdmin(id)    { return adminPasswords[id] !== undefined; }
function isAdminIn(id)  { return adminLoggedIn[id] === true; }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }

function generateKey(days, byAdmin) {
    const k = "KING-" + crypto.randomBytes(3).toString('hex').toUpperCase() + "-" + crypto.randomBytes(2).toString('hex').toUpperCase();
    keyStore[k] = { days, used:false, usedBy:null, by: byAdmin||OWNER_ID };
    return k;
}

function activateKey(userId, code) {
    const k = code.toUpperCase().trim();
    if (!keyStore[k])        return { ok:false, msg:"❌ Invalid key! Check and try again." };
    if (keyStore[k].used)    return { ok:false, msg:"❌ Key already used by someone!" };
    const days = keyStore[k].days;
    keyStore[k].used   = true;
    keyStore[k].usedBy = userId;
    const base = (usersAccess[userId] && usersAccess[userId] > Date.now()) ? usersAccess[userId] : Date.now();
    usersAccess[userId] = base + days * 86400000;
    return { ok:true, days, expiry: new Date(usersAccess[userId]).toLocaleString() };
}

function activeUsersList() {
    const now  = Date.now();
    const list = Object.entries(usersAccess).filter(([,e]) => e > now);
    if (!list.length) return "No active users.";
    return list.map(([id,e]) => "ID: " + id + " | " + ((e-now)/86400000).toFixed(1) + " days").join("\n");
}
function adminList() {
    const ids = Object.keys(adminPasswords);
    if (!ids.length) return "No admins.";
    return ids.map(id => "ID: " + id + " | " + (adminLoggedIn[id] ? "Online" : "Offline")).join("\n");
}
function allKeysList() {
    const keys = Object.entries(keyStore);
    if (!keys.length) return "No keys yet.";
    return keys.map(([k,v]) => k + " - " + (v.used ? "Used" : v.days + "d Available")).join("\n");
}

// ============================================================
//  KEYBOARDS
// ============================================================
function userMenu(id) {
    const rows = [
        ["▶️ Start Prediction"],
        ["📊 Result", "📩 Contact"],
        ["🛑 Stop Bot"]
    ];
    if (isAdmin(id)) rows.push(["👑 Admin Panel"]);
    return { keyboard: rows, resize_keyboard: true };
}

const ownerMenu = {
    keyboard: [
        ["👥 All Users",    "👮 All Admins"],
        ["👤 Add Admin",    "🗑 Remove Admin"],
        ["🔑 Generate Key", "📋 All Keys"],
        ["🟢 Add User",     "🔴 Remove User"],
        ["🔐 Set Token",    "🚪 Owner Logout"]
    ],
    resize_keyboard: true
};

const adminMenu = {
    keyboard: [
        ["👥 Active Users", "🔑 Generate Key"],
        ["🟢 Add User",     "🔴 Remove User"],
        ["📋 All Keys",     "🚪 Admin Logout"]
    ],
    resize_keyboard: true
};

// ============================================================
//  BOT
// ============================================================
let bot;
function startBot() {
    if (bot) { try { bot.stopPolling(); } catch(e){} }
    bot = new TelegramBot(BOT_TOKEN, {
        polling: { interval: 1000, autoStart: true, params: { timeout: 30 } }
    });
    bot.on("polling_error", err => { console.error("Poll error:", err.message); setTimeout(startBot, 5000); });
    bot.on("error",         err => { console.error("Bot error:",  err.message); });
    addHandlers();
    console.log("Bot running...");
}

// ============================================================
//  SAFE SEND
// ============================================================
async function send(chatId, text, opts={}) {
    try {
        return await bot.sendMessage(chatId, text, opts);
    } catch(e) {
        // retry without parse_mode if markdown error
        if (e.message && e.message.includes("parse entities")) {
            try {
                const o = {...opts}; delete o.parse_mode;
                return await bot.sendMessage(chatId, text, o);
            } catch(e2) { console.error("send failed:", e2.message); }
        } else { console.error("send error:", e.message); }
    }
}
async function sendSticker(chatId, sid) {
    try { await bot.sendSticker(chatId, sid); } catch(e) { console.error("sticker err:", e.message); }
}

// ============================================================
//  API FETCH  — tries multiple decode methods
// ============================================================
const API_HEADERS = {
    "User-Agent":       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
    "Accept":           "application/json, text/plain, */*",
    "Accept-Encoding":  "gzip, deflate, br",
    "Accept-Language":  "en-GB,en-US;q=0.9,en;q=0.8",
    "Origin":           "https://bdgwinseo.com",
    "Referer":          "https://bdgwinseo.com/",
    "Sec-Fetch-Dest":   "empty",
    "Sec-Fetch-Mode":   "cors",
    "Sec-Fetch-Site":   "cross-site"
};

function decodeBuffer(buf) {
    // 1. Direct UTF-8
    try { return JSON.parse(buf.toString("utf8")); } catch(e) {}
    // 2. gunzip
    try { return JSON.parse(zlib.gunzipSync(buf).toString("utf8")); } catch(e) {}
    // 3. inflate
    try { return JSON.parse(zlib.inflateSync(buf).toString("utf8")); } catch(e) {}
    // 4. inflateRaw
    try { return JSON.parse(zlib.inflateRawSync(buf).toString("utf8")); } catch(e) {}
    // 5. brotli
    try { return JSON.parse(zlib.brotliDecompressSync(buf).toString("utf8")); } catch(e) {}
    return null;
}

async function fetchList(retries=3) {
    for (let i=0; i<retries; i++) {
        try {
            const res = await axios.get(
                "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json?ts=" + Date.now(),
                { headers: API_HEADERS, timeout: 10000, decompress: true, responseType: "arraybuffer" }
            );
            const buf  = Buffer.from(res.data);
            const data = decodeBuffer(buf);
            if (!data) { console.error("Decode failed. Hex:", buf.slice(0,20).toString("hex")); continue; }
            const list = data?.data?.list;
            if (list && list.length > 0) return list;
            console.error("API returned no list:", JSON.stringify(data).slice(0,200));
        } catch(e) {
            console.error("Fetch attempt", i+1, "failed:", e.message);
            if (i < retries-1) await sleep(3000);
        }
    }
    return null;
}

// ============================================================
//  PREDICTION LOGIC
// ============================================================
function levelInfo(lossStreak) {
    const lvl    = Math.min(lossStreak+1, 5);
    const stars  = "⭐".repeat(lvl) + "☆".repeat(5-lvl);
    const labels = ["","LEVEL 1 SURE","LEVEL 2 SURE","LEVEL 3 SURE","LEVEL 4 SURE","LEVEL 5 SURE 🔱"];
    return { lvl, stars, label: labels[lvl] };
}

function predict(list, s) {
    const r    = list.slice(0,10).map(i => parseInt(i.number)>=5 ? "BIG" : "SMALL");
    const l5   = r.slice(0,5);
    const l10  = r.slice(0,10);
    const big5 = l5.filter(x=>x==="BIG").length;
    const big10= l10.filter(x=>x==="BIG").length;
    let p = big5>=3 ? "BIG" : "SMALL";

    // streak reversal
    let streak=1;
    for (let i=1;i<l5.length;i++) { if(l5[i]===l5[0]) streak++; else break; }
    if (streak>=3) p = l5[0]==="BIG" ? "SMALL" : "BIG";

    // loss recovery
    const ls = s.lossStreak;
    if (ls===1) p = big10>=5 ? "BIG":"SMALL";
    if (ls===2) p = l5[0]==="BIG" ? "SMALL":"BIG";
    if (ls===3) p = big5>=3 ? "BIG":"SMALL";
    if (ls>=4)  p = big10>=6 ? "BIG":"SMALL";
    return p;
}

function signalMsg(period, pred, lvl) {
    const arrow = pred==="BIG" ? "🔴" : "🔵";
    return (
        "📊 AR-LOTTERY SIGNAL\n" +
        "═══════════════════════\n" +
        "📅 Period : " + period + "\n" +
        "🎯 Predict: " + arrow + " " + pred + "\n" +
        "📈 Signal : " + lvl.label + "\n" +
        "⭐ Level  : " + lvl.stars + "\n" +
        "═══════════════════════\n" +
        "⚡ Place your bet NOW!"
    );
}

// ============================================================
//  PREDICTION LOOP
// ============================================================
async function runPredict(userId, chatId) {
    if (!running[userId]) return;

    const list = await fetchList();
    if (!list) {
        await send(chatId, "⚠️ API error, retrying in 10s...");
        return setTimeout(() => runPredict(userId, chatId), 10000);
    }

    const next = (BigInt(list[0].issueNumber)+1n).toString();

    // duplicate guard
    if (!sentPeriods[userId]) sentPeriods[userId] = new Set();
    if (sentPeriods[userId].has(next)) {
        return setTimeout(() => runPredict(userId, chatId), 5000);
    }
    sentPeriods[userId].add(next);
    if (sentPeriods[userId].size > 20) {
        sentPeriods[userId] = new Set([...sentPeriods[userId]].slice(-20));
    }

    const pred = predict(list, stats[userId]);
    const lvl  = levelInfo(stats[userId].lossStreak);

    await send(chatId, signalMsg(next, pred, lvl), {
        reply_markup: { inline_keyboard: [[{ text:"💰 BET NOW - GOAOKO", url: REG_LINK }]] }
    });

    checkResult(userId, chatId, next, pred);
}

async function checkResult(userId, chatId, target, predicted) {
    let tries = 0;
    const iv  = setInterval(async () => {
        if (!running[userId]) return clearInterval(iv);
        if (++tries > 18) {
            clearInterval(iv);
            await send(chatId, "⏱ Timeout — next period...");
            setTimeout(() => { if (running[userId]) runPredict(userId, chatId); }, 3000);
            return;
        }
        const list = await fetchList();
        if (!list) return;
        if (BigInt(list[0].issueNumber) < BigInt(target)) return;

        clearInterval(iv);
        const res    = list.find(i=>i.issueNumber===target) || list[0];
        const num    = parseInt(res.number);
        const actual = num>=5 ? "BIG":"SMALL";
        const win    = predicted===actual;
        const s      = stats[userId];
        s.total++;

        if (win) {
            s.win++; s.winStreak++; s.lossStreak=0;
            if (s.winStreak>s.maxWinStreak) s.maxWinStreak=s.winStreak;
            await send(chatId, "✅ WIN! 🎉\n🔢 Number: " + num + " → " + actual + "\n🔥 Win Streak: " + s.winStreak);
            await sendSticker(chatId, WIN_STICKER);
        } else {
            s.loss++; s.lossStreak++; s.winStreak=0;
            if (s.lossStreak>s.maxLossStreak) s.maxLossStreak=s.lossStreak;
            const next = levelInfo(s.lossStreak);
            await send(chatId, "❌ LOSS\n🔢 Number: " + num + " → " + actual + "\n⚠️ Next: " + next.label + " " + next.stars);
            await sendSticker(chatId, LOSS_STICKER);
        }
        setTimeout(() => { if (running[userId]) runPredict(userId, chatId); }, 8000);
    }, 10000);
}

// ============================================================
//  STATS
// ============================================================
function showStats(chatId, userId) {
    const d    = stats[userId];
    const rate = d.total ? ((d.win/d.total)*100).toFixed(1) : "0.0";
    const fill = d.total ? Math.round(d.win/d.total*10) : 0;
    const bar  = "🟩".repeat(fill) + "🟥".repeat(10-fill);
    send(chatId,
        "📊 PERFORMANCE REPORT\n" +
        "═══════════════════════\n" +
        "🔮 Total    : " + d.total + "\n" +
        "✅ Wins     : " + d.win   + "\n" +
        "❌ Losses   : " + d.loss  + "\n" +
        "📈 Accuracy : " + rate + "%\n" +
        bar + "\n" +
        "═══════════════════════\n" +
        "🔥 Best Win Streak  : " + d.maxWinStreak + "\n" +
        "💀 Worst Loss Streak: " + d.maxLossStreak
    );
}

// ============================================================
//  HANDLERS
// ============================================================
function addHandlers() {

    // /start
    bot.onText(/\/start/, msg => {
        const id = msg.from.id;
        initUser(id);
        const status = hasAccess(id) ? "✅ ACTIVE — " + daysLeft(id) + " days left" : "❌ NO ACCESS";
        send(msg.chat.id,
            "👑 AR-LOTTERY PREDICTION BOT\n\n" +
            "📌 Status  : " + status + "\n" +
            "🆔 Your ID : " + id + "\n" +
            "📩 Contact : " + ADMIN_HANDLE + "\n\n" +
            "🔑 Have a key? Type:\n/key YOURCODE",
            { reply_markup: userMenu(id) }
        );
    });

    // /key CODE
    bot.onText(/\/key (.+)/, (msg, match) => {
        const id  = msg.from.id;
        const res = activateKey(id, match[1].trim());
        initUser(id);
        if (res.ok) {
            send(msg.chat.id,
                "🎊 KEY ACTIVATED!\n\n" +
                "⏳ Duration : " + res.days + " days\n" +
                "📅 Expires  : " + res.expiry + "\n\n" +
                "👇 Tap Start Prediction!",
                { reply_markup: userMenu(id) }
            );
            send(OWNER_ID, "🔔 Key used!\nUser: " + id + "\nDays: " + res.days);
            Object.entries(adminLoggedIn).forEach(([aid, on]) => {
                if (on) send(parseInt(aid), "🔔 Key used!\nUser: " + id + "\nDays: " + res.days);
            });
        } else {
            send(msg.chat.id, res.msg);
        }
    });

    // /owner
    bot.onText(/\/owner/, msg => {
        if (msg.from.id !== OWNER_ID) return;
        if (ownerLoggedIn) return send(OWNER_ID, "Already logged in!", { reply_markup: ownerMenu });
        ownerState = { action:"login" };
        send(OWNER_ID, "🔐 Enter owner password:");
    });

    // /adminlogin PASSWORD
    bot.onText(/\/adminlogin (.+)/, (msg, match) => {
        const id   = msg.from.id;
        const pass = match[1].trim();
        if (!isAdmin(id)) return send(id, "You are not an admin.");
        if (pass === adminPasswords[id]) {
            adminLoggedIn[id] = true;
            send(id, "✅ Admin Login Success!\nUse 👑 Admin Panel button.", { reply_markup: userMenu(id) });
        } else {
            send(id, "❌ Wrong password!");
        }
    });

    // Main message handler
    bot.on("message", async msg => {
        const id   = msg.from.id;
        const text = msg.text;
        if (!text || text.startsWith("/")) return;
        initUser(id);

        // ═══════════════════════════════════════
        // OWNER STATE (waiting for text input)
        // ═══════════════════════════════════════
        if (id === OWNER_ID && ownerState) {
            const s = ownerState;

            // Always allow logout button
            if (text === "🚪 Owner Logout") {
                ownerLoggedIn = false; ownerState = null;
                return send(OWNER_ID, "🔒 Owner logged out.", { reply_markup: userMenu(id) });
            }

            // LOGIN
            if (s.action === "login") {
                if (text === OWNER_PASS) {
                    ownerLoggedIn = true; ownerState = null;
                    return send(OWNER_ID, "👑 Owner Login Success! Welcome Boss.", { reply_markup: ownerMenu });
                } else {
                    return send(OWNER_ID, "❌ Wrong password!");
                }
            }

            // If owner presses a menu button while in state — cancel state, handle below
            const ownerBtns = ["👥 All Users","👮 All Admins","👤 Add Admin","🗑 Remove Admin","🔑 Generate Key","📋 All Keys","🟢 Add User","🔴 Remove User","🔐 Set Token","🚪 Owner Logout"];
            if (ownerBtns.includes(text)) {
                ownerState = null; // cancel current state, fall through
            }

            // ADD ADMIN
            else if (s.action === "addadmin") {
                if (!s.step2) {
                    const tid = parseInt(text);
                    if (isNaN(tid)) return send(OWNER_ID, "❌ Invalid ID. Send valid user ID:");
                    ownerState = { action:"addadmin", step2:true, tid };
                    return send(OWNER_ID, "ID: " + tid + "\nNow set a password (min 6 chars):");
                } else {
                    if (text.length < 6) return send(OWNER_ID, "❌ Min 6 chars! Try again:");
                    adminPasswords[s.tid] = text;
                    adminLoggedIn[s.tid]  = false;
                    ownerState = null;
                    send(OWNER_ID, "✅ Admin added!\nID: " + s.tid + "\nPassword: " + text + "\n\nTell them:\n/adminlogin " + text, { reply_markup: ownerMenu });
                    send(s.tid, "🎉 You are now an Admin!\n\nLogin: /adminlogin " + text + "\nThen use 👑 Admin Panel button.");
                    return;
                }
            }

            // REMOVE ADMIN
            else if (s.action === "removeadmin") {
                const tid = parseInt(text);
                if (isNaN(tid)) return send(OWNER_ID, "❌ Invalid ID:");
                if (!adminPasswords[tid]) { ownerState=null; return send(OWNER_ID, "⚠️ Not an admin.", { reply_markup: ownerMenu }); }
                delete adminPasswords[tid]; delete adminLoggedIn[tid];
                ownerState = null;
                send(OWNER_ID, "🚫 Admin " + tid + " removed.", { reply_markup: ownerMenu });
                send(tid, "🔴 Your admin access was removed.");
                return;
            }

            // GENERATE KEY
            else if (s.action === "genkey") {
                const days = parseInt(text);
                if (isNaN(days)||days<1) return send(OWNER_ID, "❌ Enter valid number of days:");
                const key = generateKey(days, OWNER_ID);
                ownerState = null;
                return send(OWNER_ID, "🔑 Key Generated!\n\n" + key + "\n\nValid: " + days + " days\nUser types: /key " + key, { reply_markup: ownerMenu });
            }

            // ADD USER
            else if (s.action === "adduser") {
                if (!s.step2) {
                    const tid = parseInt(text);
                    if (isNaN(tid)) return send(OWNER_ID, "❌ Invalid ID:");
                    ownerState = { action:"adduser", step2:true, tid };
                    return send(OWNER_ID, "ID: " + tid + "\nHow many days?");
                } else {
                    const days = parseInt(text);
                    if (isNaN(days)||days<1) return send(OWNER_ID, "❌ Enter valid days:");
                    usersAccess[s.tid] = Date.now() + days*86400000;
                    ownerState = null;
                    send(OWNER_ID, "✅ User " + s.tid + " activated for " + days + " days.", { reply_markup: ownerMenu });
                    send(s.tid, "🎊 VIP ACCESS ACTIVATED!\n⏳ Duration: " + days + " days\nTap ▶️ Start Prediction!");
                    return;
                }
            }

            // REMOVE USER
            else if (s.action === "removeuser") {
                const tid = parseInt(text);
                if (isNaN(tid)) return send(OWNER_ID, "❌ Invalid ID:");
                const was = hasAccess(tid);
                delete usersAccess[tid]; running[tid]=false;
                ownerState = null;
                send(OWNER_ID, was ? "🚫 User " + tid + " removed." : "⚠️ User " + tid + " was not active.", { reply_markup: ownerMenu });
                if (was) send(tid, "🔴 Your access was removed. Contact admin.");
                return;
            }

            // SET TOKEN
            else if (s.action === "settoken") {
                API_HEADERS["Authorization"] = "Bearer " + text.trim();
                ownerState = null;
                return send(OWNER_ID, "✅ Token updated!", { reply_markup: ownerMenu });
            }
        }

        // ═══════════════════════════════════════
        // OWNER MENU BUTTONS
        // ═══════════════════════════════════════
        if (id === OWNER_ID && ownerLoggedIn) {
            if (text === "👥 All Users")    return send(OWNER_ID, "👥 Active Users:\n\n" + activeUsersList());
            if (text === "👮 All Admins")   return send(OWNER_ID, "👮 Admins:\n\n" + adminList());
            if (text === "👤 Add Admin")    { ownerState={action:"addadmin"}; return send(OWNER_ID, "Send the User ID to make admin:"); }
            if (text === "🗑 Remove Admin") { ownerState={action:"removeadmin"}; return send(OWNER_ID, "Send the Admin ID to remove:"); }
            if (text === "🔑 Generate Key") { ownerState={action:"genkey"}; return send(OWNER_ID, "How many days should key be valid?"); }
            if (text === "📋 All Keys")     return send(OWNER_ID, "📋 All Keys:\n\n" + allKeysList());
            if (text === "🟢 Add User")     { ownerState={action:"adduser"}; return send(OWNER_ID, "Send the User ID to activate:"); }
            if (text === "🔴 Remove User")  { ownerState={action:"removeuser"}; return send(OWNER_ID, "Send the User ID to remove:"); }
            if (text === "🔐 Set Token")    { ownerState={action:"settoken"}; return send(OWNER_ID, "Paste the new Auth Token:"); }
            if (text === "🚪 Owner Logout") { ownerLoggedIn=false; return send(OWNER_ID, "🔒 Logged out.", { reply_markup: userMenu(id) }); }
        }

        // ═══════════════════════════════════════
        // ADMIN STATE (waiting for text input)
        // ═══════════════════════════════════════
        if (isAdmin(id) && isAdminIn(id) && adminState[id]) {
            const s = adminState[id];
            const adminBtns = ["👥 Active Users","🔑 Generate Key","🟢 Add User","🔴 Remove User","📋 All Keys","🚪 Admin Logout"];

            if (text === "🚪 Admin Logout") {
                adminLoggedIn[id]=false; delete adminState[id];
                return send(id, "🔒 Admin logged out.", { reply_markup: userMenu(id) });
            }

            if (adminBtns.includes(text)) {
                delete adminState[id]; // cancel state, fall through
            }

            else if (s.action === "genkey") {
                const days = parseInt(text);
                if (isNaN(days)||days<1) return send(id, "❌ Enter valid days:");
                const key = generateKey(days, id);
                delete adminState[id];
                return send(id, "🔑 Key Generated!\n\n" + key + "\n\nValid: " + days + " days\nUser types: /key " + key, { reply_markup: adminMenu });
            }

            else if (s.action === "adduser") {
                if (!s.step2) {
                    const tid = parseInt(text);
                    if (isNaN(tid)) return send(id, "❌ Invalid ID:");
                    adminState[id] = { action:"adduser", step2:true, tid };
                    return send(id, "ID: " + tid + "\nHow many days?");
                } else {
                    const days = parseInt(text);
                    if (isNaN(days)||days<1) return send(id, "❌ Enter valid days:");
                    usersAccess[s.tid] = Date.now() + days*86400000;
                    delete adminState[id];
                    send(id, "✅ User " + s.tid + " activated for " + days + " days.", { reply_markup: adminMenu });
                    send(s.tid, "🎊 VIP ACCESS!\n⏳ " + days + " days\nTap ▶️ Start Prediction!");
                    return;
                }
            }

            else if (s.action === "removeuser") {
                const tid = parseInt(text);
                if (isNaN(tid)) return send(id, "❌ Invalid ID:");
                const was = hasAccess(tid);
                delete usersAccess[tid]; running[tid]=false;
                delete adminState[id];
                send(id, was ? "🚫 User " + tid + " removed." : "⚠️ Not active.", { reply_markup: adminMenu });
                if (was) send(tid, "🔴 Access removed. Contact admin.");
                return;
            }
        }

        // ═══════════════════════════════════════
        // ADMIN MENU BUTTONS
        // ═══════════════════════════════════════
        if (isAdmin(id) && isAdminIn(id)) {
            if (text === "👥 Active Users") return send(id, "👥 Active Users:\n\n" + activeUsersList());
            if (text === "🔑 Generate Key") { adminState[id]={action:"genkey"}; return send(id, "How many days?"); }
            if (text === "🟢 Add User")     { adminState[id]={action:"adduser"}; return send(id, "Send User ID to activate:"); }
            if (text === "🔴 Remove User")  { adminState[id]={action:"removeuser"}; return send(id, "Send User ID to remove:"); }
            if (text === "📋 All Keys")     return send(id, "📋 Keys:\n\n" + allKeysList());
            if (text === "🚪 Admin Logout") { adminLoggedIn[id]=false; return send(id, "🔒 Logged out.", { reply_markup: userMenu(id) }); }
        }

        // ═══════════════════════════════════════
        // ADMIN PANEL BUTTON (shows menu)
        // ═══════════════════════════════════════
        if (text === "👑 Admin Panel" && isAdmin(id)) {
            if (!isAdminIn(id)) return send(id, "🔐 Login first:\n/adminlogin YOUR_PASSWORD");
            return send(id, "👑 Admin Panel\nChoose action:", { reply_markup: adminMenu });
        }

        // ═══════════════════════════════════════
        // USER BUTTONS
        // ═══════════════════════════════════════
        if (text === "▶️ Start Prediction") {
            if (!hasAccess(id)) {
                return send(msg.chat.id,
                    "❌ Access Denied!\n\n📩 Contact " + ADMIN_HANDLE + "\n🆔 Your ID: " + id + "\n\n🔑 Have key? Type:\n/key YOURCODE"
                );
            }
            if (running[id]) return send(msg.chat.id, "⚠️ Already running! Tap 🛑 Stop Bot first.");
            running[id]      = true;
            sentPeriods[id]  = new Set();
            await send(msg.chat.id, "🚀 PREDICTION ENGINE ACTIVATED!\n⏳ Fetching next period...");
            runPredict(id, msg.chat.id);
        }

        if (text === "🛑 Stop Bot") {
            running[id] = false;
            send(msg.chat.id, "🛑 Prediction stopped.");
        }

        if (text === "📊 Result")  showStats(msg.chat.id, id);

        if (text === "📩 Contact") {
            send(msg.chat.id,
                "📩 Contact Admin\n\n🔗 " + ADMIN_HANDLE + "\n🆔 Your ID: " + id + "\n\nSend your ID to admin for key."
            );
        }
    });
}

// ============================================================
//  START
// ============================================================
startBot();

const { Client, GatewayIntentBits, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, Events, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js'); 
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// ---------------------------
// Load token
// ---------------------------
let DISCORD_TOKEN; 
try {
    DISCORD_TOKEN = fs.readFileSync('./token.txt', 'utf8').trim();
} catch {
    console.error("CRITICAL: token.txt is missing!");
    process.exit(1);
}

// ---------------------------
// Client & Database
// ---------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const db = new sqlite3.Database('./data.sqlite');
db.configure('busyTimeout', 5000);

db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');

    db.run('CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, lastDaily INTEGER DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS user_quiz (userId TEXT PRIMARY KEY, quizId INTEGER NOT NULL, askedAt INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS quiz_history (userId TEXT PRIMARY KEY, askedIds TEXT NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS guild_users (guildId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS quiz_stats (userId TEXT PRIMARY KEY, correct INTEGER NOT NULL DEFAULT 0, wrong INTEGER NOT NULL DEFAULT 0)');
    db.run('CREATE TABLE IF NOT EXISTS guess_active (userId TEXT PRIMARY KEY, playerName TEXT NOT NULL, askedAt INTEGER NOT NULL, hintIndex INTEGER NOT NULL DEFAULT 1)');
    db.run('CREATE TABLE IF NOT EXISTS guess_cooldown (userId TEXT PRIMARY KEY, lastUsed INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS server_coins (guildId TEXT NOT NULL, userId TEXT NOT NULL, coins INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guildId, userId))');
    db.run('CREATE TABLE IF NOT EXISTS server_shop (guildId TEXT NOT NULL, itemName TEXT NOT NULL, roleId TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (guildId, itemName))');
});

// ---------------------------
// DB Helpers
// ---------------------------
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));

const getUserData = userId => new Promise((res, rej) => {
    db.get('SELECT coins, lastDaily FROM users WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        else if (!r) {
            db.run('INSERT OR IGNORE INTO users (userId, coins, lastDaily) VALUES (?,0,0)', [userId], () => res({ coins: 0, lastDaily: 0 }));
        } else res(r);
    });
});

const addUserCoins = (userId, amount, guildId = null) => new Promise((res, rej) => {
    // Always update global coins
    db.run('INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)', [userId], err => {
        if (err) return rej(err);
        db.run('UPDATE users SET coins = coins + ? WHERE userId = ?', [amount, userId], e => {
            if (e) return rej(e);
            // If guildId is provided, also update server-specific coins
            if (guildId) {
                db.run('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId], err2 => {
                    if (err2) return rej(err2);
                    db.run('UPDATE server_coins SET coins = coins + ? WHERE guildId = ? AND userId = ?', [amount, guildId, userId], e2 => e2 ? rej(e2) : res());
                });
            } else {
                res();
            }
        });
    });
});

const getServerUserData = (guildId, userId) => new Promise((res, rej) => {
    db.get('SELECT coins FROM server_coins WHERE guildId = ? AND userId = ?', [guildId, userId], (e, r) => {
        if (e) rej(e);
        else if (!r) {
            db.run('INSERT OR IGNORE INTO server_coins (guildId, userId, coins) VALUES (?, ?, 0)', [guildId, userId], () => res({ coins: 0 }));
        } else res(r);
    });
});

const setActiveQuestion = (userId, quizId) => new Promise((res, rej) => {
    db.run(
        'INSERT INTO user_quiz (userId, quizId, askedAt) VALUES (?, ?, ?) ON CONFLICT(userId) DO UPDATE SET quizId=excluded.quizId, askedAt=excluded.askedAt',
        [userId, quizId, Date.now()],
        e => e ? rej(e) : res()
    );
});

const getActiveQuestion = userId => new Promise((res, rej) => {
    db.get('SELECT quizId, askedAt FROM user_quiz WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null));
});

const clearActiveQuestion = userId => new Promise((res, rej) => db.run('DELETE FROM user_quiz WHERE userId = ?', [userId], e => e ? rej(e) : res()));

const getCooldown = userId => new Promise((res, rej) => db.get('SELECT lastUsed FROM quiz_cooldown WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null)));
const setCooldown = userId => new Promise((res, rej) => db.run('INSERT INTO quiz_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()], e => e ? rej(e) : res()));

const getQuizHistory = userId => new Promise((res, rej) => {
    db.get('SELECT askedIds FROM quiz_history WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        res(r && r.askedIds ? r.askedIds.split(',').map(Number) : []);
    });
});

const addQuizToHistory = (userId, quizId) => new Promise((res, rej) => {
    getQuizHistory(userId).then(history => {
        if (!history.includes(quizId)) history.push(quizId);
        db.run('INSERT INTO quiz_history (userId, askedIds) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET askedIds=excluded.askedIds', [userId, history.join(',')], e => e ? rej(e) : res());
    });
});

const upsertGuildUser = (guildId, userId) => new Promise((res, rej) => {
    db.run('INSERT OR IGNORE INTO guild_users (guildId, userId) VALUES (?, ?)', [guildId, userId], e => e ? rej(e) : res());
});

const getQuizStats = userId => new Promise((res, rej) => {
    db.get('SELECT correct, wrong FROM quiz_stats WHERE userId = ?', [userId], (e, r) => {
        if (e) rej(e);
        else if (!r) res({ correct: 0, wrong: 0 });
        else res(r);
    });
});

const incQuizStat = (userId, column) => new Promise((res, rej) => {
    db.run('INSERT OR IGNORE INTO quiz_stats (userId, correct, wrong) VALUES (?, 0, 0)', [userId], err => {
        if (err) return rej(err);
        db.run(`UPDATE quiz_stats SET ${column} = ${column} + 1 WHERE userId = ?`, [userId], e => e ? rej(e) : res());
    });
});

const getGuessActive = userId => new Promise((res, rej) => {
    db.get('SELECT playerName, askedAt, hintIndex FROM guess_active WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null));
});
const setGuessActive = (userId, playerName) => new Promise((res, rej) => {
    db.run('INSERT INTO guess_active (userId, playerName, askedAt, hintIndex) VALUES (?, ?, ?, 1) ON CONFLICT(userId) DO UPDATE SET playerName=excluded.playerName, askedAt=excluded.askedAt, hintIndex=excluded.hintIndex', [userId, playerName, Date.now()], e => e ? rej(e) : res());
});
const setGuessHintIndex = (userId, hintIndex) => new Promise((res, rej) => db.run('UPDATE guess_active SET hintIndex = ? WHERE userId = ?', [hintIndex, userId], e => e ? rej(e) : res()));
const clearGuessActive = userId => new Promise((res, rej) => db.run('DELETE FROM guess_active WHERE userId = ?', [userId], e => e ? rej(e) : res()));
const getGuessCooldown = userId => new Promise((res, rej) => db.get('SELECT lastUsed FROM guess_cooldown WHERE userId = ?', [userId], (e, r) => e ? rej(e) : res(r || null)));
const setGuessCooldown = userId => new Promise((res, rej) => db.run('INSERT INTO guess_cooldown (userId, lastUsed) VALUES (?, ?) ON CONFLICT(userId) DO UPDATE SET lastUsed=excluded.lastUsed', [userId, Date.now()], e => e ? rej(e) : res()));

// ---------------------------
// Logic Helpers
// ---------------------------
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, '');
const isCloseEnough = (u, a) => {
    u = norm(u); a = norm(a);
    if (!u || !a) return false;
    if (u === a) return true;
    let diff = 0;
    for (let i = 0; i < Math.min(u.length, a.length); i++) if (u[i] !== a[i]) diff++;
    diff += Math.abs(u.length - a.length);
    return diff <= (a.length > 6 ? 2 : 1);
};

const STOP_WORDS = new Set(['the','a','an','on','of','to','with','in','at','by','for','and','or','from','into','onto','over','under']);
const SYN_MAP = {
    "queenside": ["queen","side"],
    "queen's": ["queen"],
    "queens": ["queen"],
    "kingside": ["king","side"],
    "king's": ["king"],
    "kings": ["king"],
    "backrank": ["back","rank"],
    "fianchetto": ["fianchetto"],
    "enpassant": ["en","passant"],
    "en": ["en"],
    "passant": ["passant"],
    "castle": ["castling"],
    "o-o-o": ["castling","queen","side"],
    "o-o": ["castling","king","side"],
    "mate": ["checkmate"],
    "promotion": ["promotion","promote"],
    "promote": ["promotion"],
    "battery": ["battery","double"],
    "double": ["double"],
    "forking": ["fork"],
    "fork": ["fork"],
    "skewer": ["skewer"],
    "pin": ["pin"],
    "zugzwang": ["zugzwang"],
    "zwischenzug": ["zwischenzug","intermediate"],
    "intermediate": ["zwischenzug"],
    "gambit": ["gambit"],
    "declined": ["declined"],
    "accepted": ["accepted"],
    "defense": ["defense"],
    "attack": ["attack"],
    "break": ["break"],
    "pawn": ["pawn"],
    "rank": ["rank"],
    "file": ["file"],
    "queen": ["queen"],
    "king": ["king"],
    "rook": ["rook"],
    "bishop": ["bishop"],
    "knight": ["knight"]
};

const canonTokens = (s) => {
    if (!s) return new Set();
    s = String(s).toLowerCase().replace(/[^a-z0-9\s\-']/g, ' ');
    s = s.replace(/-/g, ' ');
    s = s.replace(/'/g, '');
    const raw = s.split(/\s+/).filter(Boolean);
    let tokens = [];
    for (const t of raw) {
        if (STOP_WORDS.has(t)) continue;
        if (SYN_MAP[t]) tokens.push(...SYN_MAP[t]);
        else tokens.push(t);
    }
    const out = new Set(tokens.filter(x => !STOP_WORDS.has(x)));
    return out;
};

const subsetMatch = (a, b) => {
    for (const t of a) { if (!b.has(t)) return false; }
    return true;
};

const isAnswerMatch = (input, q) => {
    const inSet = canonTokens(input);
    const ansSet = canonTokens(q.answer);
    if (subsetMatch(ansSet, inSet)) return true;
    if (Array.isArray(q.aliases)) {
        for (const al of q.aliases) {
            const alSet = canonTokens(al);
            if (subsetMatch(alSet, inSet)) return true;
        }
    }
    if (ansSet.size === 1) {
        if (isCloseEnough(input, q.answer)) return true;
        if (Array.isArray(q.aliases) && q.aliases.some(a => isCloseEnough(input, a))) return true;
    }
    return false;
};

const nameTokens = s => {
    s = String(s || "").toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/[^a-z0-9\s]/g, ' ');
    const parts = s.split(/\s+/).filter(Boolean).filter(w => !STOP_WORDS.has(w));
    return new Set(parts);
};
const isNameMatch = (input, name) => {
    const a = nameTokens(name);
    const b = nameTokens(input);
    for (const t of a) { if (!b.has(t)) return false; }
    return true;
};

// ---------------------------
// Quiz Pool & Shop
// ---------------------------
const QUIZ_POOL = [
    { id: 1, type: 'chess', question: "How many squares are on a chessboard?", answer: "64", reward: 5 },
    { id: 2, type: 'chess', question: "Which piece moves in an L-shape?", answer: "Knight", aliases: ["horse"], reward: 10 },
    { id: 3, type: "chess", question: "What is the term for attacking the king?", answer: "Check", reward: 10 },
    { id: 4, type: "chess", question: "What is the final aim of chess?", answer: "Checkmate", aliases: ["mate"], reward: 15 },
    { id: 5, type: "chess", question: "Which move lets king and rook move together?", answer: "Castling", aliases: ["castle"], reward: 15 },
    { id: 6, type: "chess", question: "Which color moves first?", answer: "White", reward: 5 },
    { id: 7, type: "chess", question: "Which piece moves any number of squares diagonally?", answer: "Bishop", reward: 10 },
    { id: 8, type: "chess", question: "Which piece combines rook and bishop movement?", answer: "Queen", reward: 15 },
    { id: 9, type: "chess", question: "Which piece moves forward and captures diagonally?", answer: "Pawn", reward: 10 },
    { id: 10, type: "chess", question: "What is the special pawn capture immediately after a two-step move called?", answer: "En passant", aliases: ["enpassant", "en passant capture"], reward: 15 },
    { id: 11, type: "chess", question: "What is promoting a pawn to a queen called?", answer: "Promotion", aliases: ["pawn promotion"], reward: 10 },
    { id: 12, type: "chess", question: "Name the opening starting with 1. e4 e5 2. Nf3 Nc6 3. Bb5.", answer: "Ruy Lopez", aliases: ["spanish"], reward: 15 },
    { id: 13, type: "chess", question: "Name the opening 1. d4 Nf6 2. c4 g6.", answer: "Indian Defense", aliases: ["kings indian", "queen's indian"], reward: 15 },
    { id: 14, type: "chess", question: "What is a draw due to a repeated position three times called?", answer: "Threefold repetition", aliases: ["threefold"], reward: 15 },
    { id: 15, type: "chess", question: "What is a draw when no legal moves and king is not in check?", answer: "Stalemate", reward: 15 },
    { id: 16, type: "chess", question: "What is the 50-move rule based on?", answer: "No pawn move or capture", aliases: ["fifty move rule"], reward: 15 },
    { id: 17, type: "chess", question: "What does FIDE stand for?", answer: "International Chess Federation", aliases: ["fide"], reward: 10 },
    { id: 18, type: "chess", question: "Who is known as the 'Mozart of chess'?", answer: "Magnus Carlsen", aliases: ["carlsen"], reward: 10 },
    { id: 19, type: "chess", question: "Who wrote 'My System'?", answer: "Aron Nimzowitsch", aliases: ["nimzowitsch"], reward: 15 },
    { id: 20, type: "chess", question: "Which opening starts with 1. e4 c5?", answer: "Sicilian Defense", aliases: ["sicilian"], reward: 15 },
    { id: 21, type: "chess", question: "Which opening starts with 1. d4 d5 2. c4?", answer: "Queen's Gambit", aliases: ["queens gambit"], reward: 15 },
    { id: 22, type: "chess", question: "Name the tactic: a move that creates two simultaneous threats.", answer: "Fork", reward: 10 },
    { id: 23, type: "chess", question: "Name the tactic: blocking a square to cut off defense.", answer: "Interference", reward: 10 },
    { id: 24, type: "chess", question: "Name the tactic: sacrificing material to open lines.", answer: "Sacrifice", reward: 10 },
    { id: 25, type: "chess", question: "Name the tactic: winning material by trapping a piece.", answer: "Trap", reward: 10 },
    { id: 26, type: "chess", question: "Name the tactic: attacking the king with a forcing move.", answer: "Check", reward: 5 },
    { id: 27, type: "chess", question: "Name the tactic: pinning a piece to a more valuable one.", answer: "Pin", reward: 10 },
    { id: 28, type: "chess", question: "Name the tactic: a piece behind another is attacked after the front moves.", answer: "Skewer", reward: 10 },
    { id: 29, type: "chess", question: "Name the tactic: decoying a piece onto a bad square.", answer: "Decoy", reward: 10 },
    { id: 30, type: "chess", question: "Name the tactic: removing the guard of a piece.", answer: "Deflection", aliases: ["remove the guard"], reward: 10 },
    { id: 31, type: "chess", question: "Which endgame is drawn with only king vs king?", answer: "King vs King", aliases: ["bare kings"], reward: 5 },
    { id: 32, type: "chess", question: "What is opposition in king and pawn endgames?", answer: "Kings facing each other with a square in between", aliases: ["opposition"], reward: 15 },
    { id: 33, type: "chess", question: "What is zugzwang?", answer: "Being forced to move to a worse position", reward: 15 },
    { id: 34, type: "chess", question: "Which piece is worth about 9 points?", answer: "Queen", reward: 5 },
    { id: 35, type: "chess", question: "Which piece is worth about 5 points?", answer: "Rook", reward: 5 },
    { id: 36, type: "chess", question: "Which piece is worth about 3 points (two types)?", answer: "Knight and Bishop", aliases: ["minor pieces"], reward: 10 },
    { id: 37, type: "chess", question: "What is the term for two bishops on adjacent diagonals", answer: "Bishop pair", aliases: ["two bishops"], reward: 10 },
    { id: 38, type: "chess", question: "What is a fianchetto?", answer: "Developing bishop to b2/g2/b7/g7", reward: 10 },
    { id: 39, type: "chess", question: "Name the tactic: discovered attack on a piece or king.", answer: "Discovered attack", reward: 10 },
    { id: 40, type: "chess", question: "Name the tactic: discovered check.", answer: "Discovered check", reward: 10 },
    { id: 41, type: "chess", question: "What is a double attack?", answer: "Two threats at once", reward: 10 },
    { id: 42, type: "chess", question: "What is perpetual check?", answer: "Repeated checks forcing a draw", reward: 15 },
    { id: 43, type: "chess", question: "What is a passed pawn?", answer: "Pawn with no opposing pawns blocking its path", reward: 10 },
    { id: 44, type: "chess", question: "What is an isolated pawn?", answer: "Pawn with no same-color pawns on adjacent files", reward: 10 },
    { id: 45, type: "chess", question: "What is a backward pawn?", answer: "Pawn behind others and cannot advance safely", reward: 10 },
    { id: 46, type: "chess", question: "What is a doubled pawn?", answer: "Two pawns on same file", reward: 10 },
    { id: 47, type: "chess", question: "What is a gambit?", answer: "Sacrificing material for initiative", reward: 10 },
    { id: 48, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4.", answer: "Italian Game", aliases: ["giuoco piano"], reward: 15 },
    { id: 49, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 d6.", answer: "Philidor Defense", aliases: ["philidor"], reward: 15 },
    { id: 50, type: "chess", question: "Name the opening: 1. e4 e5 2. f4.", answer: "King's Gambit", aliases: ["kings gambit"], reward: 15 },
    { id: 51, type: "chess", question: "Name the opening: 1. d4 d5 2. Nf3 Nf6 3. c4.", answer: "Queen's Gambit Declined", aliases: ["qgd"], reward: 15 },
    { id: 52, type: "chess", question: "Name the opening: 1. d4 f5.", answer: "Dutch Defense", aliases: ["dutch"], reward: 15 },
    { id: 53, type: "chess", question: "Name the opening: 1. e4 e6.", answer: "French Defense", aliases: ["french"], reward: 15 },
    { id: 54, type: "chess", question: "Name the opening: 1. e4 d6.", answer: "Pirc Defense", aliases: ["pirc"], reward: 15 },
    { id: 55, type: "chess", question: "Name the opening: 1. e4 c6.", answer: "Caro-Kann Defense", aliases: ["caro kann"], reward: 15 },
    { id: 56, type: "chess", question: "Name the opening: 1. e4 d5.", answer: "Scandinavian Defense", aliases: ["center counter"], reward: 15 },
    { id: 57, type: "chess", question: "Name the opening: 1. e4 b6.", answer: "Owen's Defense", aliases: ["owens"], reward: 15 },
    { id: 58, type: "chess", question: "Name the opening: 1. e4 g6.", answer: "Modern Defense", aliases: ["modern"], reward: 15 },
    { id: 59, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 e6.", answer: "Nimzo-Indian Defense", aliases: ["nimzo indian"], reward: 15 },
    { id: 60, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 g6 3. Nc3 Bg7.", answer: "King's Indian Defense", aliases: ["kings indian"], reward: 15 },
    { id: 61, type: "chess", question: "Name the opening: 1. d4 d5 2. c4 c6.", answer: "Slav Defense", aliases: ["slav"], reward: 15 },
    { id: 62, type: "chess", question: "Name the opening: 1. d4 d5 2. c4 e6.", answer: "Queen's Gambit Declined", aliases: ["qgd"], reward: 15 },
    { id: 63, type: "chess", question: "Name the opening: 1. c4.", answer: "English Opening", aliases: ["english"], reward: 15 },
    { id: 64, type: "chess", question: "Name the opening: 1. Nf3.", answer: "Reti Opening", aliases: ["reti"], reward: 15 },
    { id: 65, type: "chess", question: "Name the opening: 1. b3.", answer: "Larsen's Opening", aliases: ["nimzo larsen"], reward: 15 },
    { id: 66, type: "chess", question: "Name the opening: 1. g3.", answer: "Hungarian Opening", aliases: ["kings fianchetto"], reward: 10 },
    { id: 67, type: "chess", question: "Which checkmate uses two rooks to trap the king on a rank or file?", answer: "Ladder mate", aliases: ["rook roller"], reward: 15 },
    { id: 68, type: "chess", question: "Which checkmate uses queen and bishop on h7/h2?", answer: "Scholar's mate", aliases: ["scholars"], reward: 10 },
    { id: 69, type: "chess", question: "Which checkmate pattern uses back rank weakness?", answer: "Back rank mate", reward: 10 },
    { id: 70, type: "chess", question: "Which mate involves bishop and knight coordinating?", answer: "Bishop and knight mate", reward: 15 },
    { id: 71, type: "chess", question: "Which mate involves smothered king with a knight?", answer: "Smothered mate", reward: 15 },
    { id: 72, type: "chess", question: "Which mate involves sacrifice on h7 followed by Ng5/Qh5?", answer: "Greek gift", aliases: ["greek gift sacrifice"], reward: 15 },
    { id: 73, type: "chess", question: "What is a blockade?", answer: "Placing a piece to stop an enemy pawn advance", reward: 10 },
    { id: 74, type: "chess", question: "What is prophylaxis?", answer: "Preventing opponent's plan", reward: 10 },
    { id: 75, type: "chess", question: "What is tempo?", answer: "A unit of time for a move advantage", reward: 10 },
    { id: 76, type: "chess", question: "What is initiative?", answer: "Ability to make threats forcing responses", reward: 10 },
    { id: 77, type: "chess", question: "What is a zwischenzug?", answer: "An in-between move", aliases: ["in-between"], reward: 15 },
    { id: 78, type: "chess", question: "What is a battery?", answer: "Two pieces lined up on a file, rank, or diagonal", reward: 10 },
    { id: 79, type: "chess", question: "What is a majority attack with pawns?", answer: "Pawn majority push", reward: 10 },
    { id: 80, type: "chess", question: "What is the square of the pawn rule?", answer: "King reaches square if inside pawn's square", reward: 15 },
    { id: 81, type: "chess", question: "What is triangulation in endgames?", answer: "Wasting moves to gain opposition", reward: 15 },
    { id: 82, type: "chess", question: "What is underpromotion?", answer: "Promoting to a piece other than queen", reward: 15 },
    { id: 83, type: "chess", question: "What is stalemate tactic for a draw?", answer: "Forcing no legal move without check", reward: 15 },
    { id: 84, type: "chess", question: "What is the main idea of the London System?", answer: "Setup with d4, Nf3, Bf4, e3, c3", aliases: ["london system"], reward: 15 },
    { id: 85, type: "chess", question: "Which opening starts with 1. d4 and Bf4 early?", answer: "London System", aliases: ["london"], reward: 15 },
    { id: 86, type: "chess", question: "Who was the first official World Chess Champion?", answer: "Wilhelm Steinitz", aliases: ["steinitz"], reward: 10 },
    { id: 87, type: "chess", question: "Who defeated Kasparov in 2000 to become World Champion?", answer: "Vladimir Kramnik", aliases: ["kramnik"], reward: 10 },
    { id: 88, type: "chess", question: "What is castling long?", answer: "Castling queenside", aliases: ["queenside castling", "o-o-o"], reward: 10 },
    { id: 89, type: "chess", question: "What is castling short?", answer: "Castling kingside", aliases: ["kingside castling", "o-o"], reward: 10 },
    { id: 90, type: "chess", question: "What is the en passant condition?", answer: "Capture only immediately after a two-step pawn move", reward: 15 },
    { id: 91, type: "chess", question: "What does ELO measure?", answer: "Player rating strength", aliases: ["elo rating"], reward: 10 },
    { id: 92, type: "chess", question: "What is the term for a line starting with a12? (illegal)", answer: "Illegal move", reward: 5 },
    { id: 93, type: "chess", question: "What is algebraic notation for checkmate?", answer: "#", aliases: ["hash"], reward: 5 },
    { id: 94, type: "chess", question: "What is algebraic notation for check?", answer: "+", aliases: ["plus"], reward: 5 },
    { id: 95, type: "chess", question: "What is the term for moving the same piece twice in the opening unnecessarily?", answer: "Loss of tempo", reward: 10 },
    { id: 96, type: "chess", question: "What is the doel of development?", answer: "Activate pieces quickly", aliases: ["development"], reward: 10 },
    { id: 97, type: "chess", question: "Where should you usually place rooks?", answer: "Open files", reward: 10 },
    { id: 98, type: "chess", question: "What is a half-open file?", answer: "File with no pawn of one side", reward: 10 },
    { id: 99, type: "chess", question: "What is the center in chess?", answer: "Squares e4, d4, e5, d5", reward: 10 },
    { id: 100, type: "chess", question: "What is a checkmate with queen and king called?", answer: "Basic mate", aliases: ["queen mate"], reward: 10 },
    { id: 101, type: "chess", question: "What is a checkmate with rook and king called?", answer: "Rook mate", reward: 10 },
    { id: 102, type: "chess", question: "What is the tactic of sacrificing an exchange called?", answer: "Exchange sacrifice", aliases: ["sacrifice exchange"], reward: 15 },
    { id: 103, type: "chess", question: "What is the tactic of doubling rooks on a file?", answer: "Rook battery", reward: 10 },
    { id: 104, type: "chess", question: "What is the tactic of opening a diagonal for a bishop?", answer: "Pawn break", reward: 10 },
    { id: 105, type: "chess", question: "Name the tactic: quiet move setting up a tactic next move.", answer: "Quiet move", reward: 10 },
    { id: 106, type: "chess", question: "What are connected passed pawns?", answer: "Adjacent passed pawns", reward: 10 },
    { id: 107, type: "chess", question: "What is a king's shelter of pawns called?", answer: "Pawn shield", reward: 10 },
    { id: 108, type: "chess", question: "Name the mate using queen sacrifice then smothered mate.", answer: "Levien/Philidor combination", aliases: ["queen sac smothered"], reward: 15 },
    { id: 109, type: "chess", question: "Name the mate pattern where queen mates on back rank with rook block.", answer: "Back rank mate", reward: 10 },
    { id: 110, type: "chess", question: "What is an outpost?", answer: "Strong square for knight or piece, hard to chase away", reward: 10 },
    { id: 111, type: "chess", question: "What is a hole in pawn structure?", answer: "Weak square that cannot be defended by pawns", reward: 10 },
    { id: 112, type: "chess", question: "Name the tactic: line-clearance for another piece.", answer: "Clearance", reward: 10 },
    { id: 113, type: "chess", question: "Name the tactic: 'windmill' with rook/bishop discovering checks.", answer: "Windmill", reward: 15 },
    { id: 114, type: "chess", question: "What is the most valuable piece?", answer: "King", reward: 5 },
    { id: 115, type: "chess", question: "What is a draw by insufficient mating material?", answer: "Insufficient material", reward: 10 },
    { id: 116, type: "chess", question: "What is perpetual pursuit?", answer: "Repeated threats to force draw", reward: 10 },
    { id: 117, type: "chess", question: "What is a hook pawn?", answer: "Pawn used to create pawn storms", reward: 10 },
    { id: 118, type: "chess", question: "What is a minority attack?", answer: "Using fewer pawns to attack more pawns", reward: 10 },
    { id: 119, type: "chess", question: "What is the strongest square for knights usually?", answer: "Outposts in center", reward: 10 },
    { id: 120, type: "chess", question: "What is the rook on the seventh rank called?", answer: "Rook on seventh", aliases: ["rook on 7th"], reward: 10 },
    { id: 121, type: "chess", question: "Name the endgame: rook vs pawn with king support is often drawn if pawn is rook pawn.", answer: "Rook vs rook pawn draw", reward: 15 },
    { id: 122, type: "chess", question: "What is opposition diagonal called for bishops?", answer: "Opposite-colored bishops", reward: 10 },
    { id: 123, type: "chess", question: "Opposite-colored bishops endgames often result in what?", answer: "Draw", reward: 10 },
    { id: 124, type: "chess", question: "Same-colored bishops endgames are often decided by what?", answer: "Pawn breaks and zugzwang", reward: 15 },
    { id: 125, type: "chess", question: "Name the opening line: 1. e4 e5 2. Nf3 Nc6 3. d4.", answer: "Scotch Game", aliases: ["scotch"], reward: 15 },
    { id: 126, type: "chess", question: "Name the defense: 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6.", answer: "Najdorf", aliases: ["sicilian najdorf"], reward: 15 },
    { id: 127, type: "chess", question: "Name the line: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6.", answer: "Ruy Lopez, Morphy Defense", aliases: ["morphy defense"], reward: 15 },
    { id: 128, type: "chess", question: "Name the gambit: 1. d4 d5 2. c4 e6 3. Nc3 c5.", answer: "Tarrasch Defense", aliases: ["tarrasch"], reward: 15 },
    { id: 129, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 e6 3. Nc3 Bb4.", answer: "Nimzo-Indian Defense", reward: 15 },
    { id: 130, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 g6 3. g3.", answer: "Fianchetto King's Indian", aliases: ["kings indian fianchetto"], reward: 15 },
    { id: 131, type: "chess", question: "Name the pawn structure with pawns on c3/d4/e3.", answer: "Stonewall-like (London) structure", aliases: ["stonewall", "london"], reward: 10 },
    { id: 132, type: "chess", question: "Name the tactic: overload a defender to win material.", answer: "Overloading", reward: 10 },
    { id: 133, type: "chess", question: "Name the tactic: prevent castling by pinning f-pawn or attacking g-pawn.", answer: "King safety attack", reward: 10 },
    { id: 134, type: "chess", question: "What is the main goal of the opening?", answer: "Development and king safety", reward: 10 },
    { id: 135, type: "chess", question: "What is the main goal of the middlegame?", answer: "Create weaknesses and attack", reward: 10 },
    { id: 136, type: "chess", question: "What is the main goal of the endgame?", answer: "Push passed pawns and activate king", reward: 10 },
    { id: 137, type: "chess", question: "What is the term for exchanging queens early?", answer: "Early queen trade", aliases: ["queen trade"], reward: 10 },
    { id: 138, type: "chess", question: "What is the best piece to blockade passed pawns?", answer: "Knight", reward: 10 },
    { id: 139, type: "chess", question: "What is the tactic theme when king is trapped by own pieces?", answer: "Self-mate motifs", reward: 10 },
    { id: 140, type: "chess", question: "What is the term for a pawn storm?", answer: "Pawn storm", reward: 10 },
    { id: 141, type: "chess", question: "What is the Dutch Leningrad setup's key pawn?", answer: "f-pawn", aliases: ["leningrad key pawn"], reward: 10 },
    { id: 142, type: "chess", question: "Which opening features the Botvinnik setup c4, e4, d3, Nc3, g3?", answer: "English, Botvinnik System", aliases: ["botvinnik"], reward: 15 },
    { id: 143, type: "chess", question: "Which defense uses ...c5 against 1.d4?", answer: "Benoni Defense", aliases: ["benoni"], reward: 15 },
    { id: 144, type: "chess", question: "Which defense uses ...b5 early against 1.d4 c4?", answer: "Budapest Gambit", aliases: ["budapest"], reward: 15 },
    { id: 145, type: "chess", question: "Which system is known for solid pawn chain d5-e6?", answer: "French Defense", reward: 10 },
    { id: 146, type: "chess", question: "Name the tactic: removing the defender with a capture.", answer: "Remove the defender", aliases: ["deflection"], reward: 10 },
    { id: 147, type: "chess", question: "Name the classic endgame study composer: Troitsky.", answer: "Alexey Troitsky", aliases: ["troitsky"], reward: 10 },
    { id: 148, type: "chess", question: "What is the Troitsky line about?", answer: "Knight vs two connected passed pawns", reward: 15 },
    { id: 149, type: "chess", question: "What is an exchange up?", answer: "Having a rook for a minor piece", reward: 10 },
    { id: 150, type: "chess", question: "What is a material imbalance?", answer: "Unequal material values", reward: 10 },
    { id: 151, type: "chess", question: "What is fortress?", answer: "Defensive setup preventing progress", reward: 15 },
    { id: 152, type: "chess", question: "What is the term for pre-move in online chess?", answer: "Premove", reward: 5 },
    { id: 153, type: "chess", question: "What is castling condition about moving king or rook previously?", answer: "Cannot castle if moved before", reward: 15 },
    { id: 154, type: "chess", question: "What is the term for pin against the king?", answer: "Absolute pin", reward: 10 },
    { id: 155, type: "chess", question: "What is the term for pin against a queen or rook?", answer: "Relative pin", reward: 10 },
    { id: 156, type: "chess", question: "What is time trouble called?", answer: "Zeitnot", reward: 10 },
    { id: 157, type: "chess", question: "What is the move repetition draw rule?", answer: "Threefold repetition", reward: 15 },
    { id: 158, type: "chess", question: "Name the defense: 1. d4 Nf6 2. c4 e5.", answer: "Budapest Gambit", reward: 15 },
    { id: 159, type: "chess", question: "Name the defense: 1. d4 c5.", answer: "Benoni Defense", reward: 15 },
    { id: 160, type: "chess", question: "Name the defense: 1. d4 d6 2. c4 e5.", answer: "Old Indian Defense", aliases: ["old indian"], reward: 15 },
    { id: 161, type: "chess", question: "What is the Lucena Position?", answer: "Winning endgame position for the side with the pawn and rook", aliases: ["lucena"], reward: 15 },
    { id: 162, type: "chess", question: "What is the Philidor Position?", answer: "Drawing endgame position for the defending side in rook endgames", aliases: ["philidor position"], reward: 15 },
    { id: 163, type: "chess", question: "What is a 'Desperado' piece?", answer: "A piece that is going to be lost anyway and captures as much as possible", reward: 15 },
    { id: 164, type: "chess", question: "What is a 'Bad Bishop'?", answer: "A bishop blocked by its own pawns on its color", reward: 10 },
    { id: 165, type: "chess", question: "What is a 'Good Bishop'?", answer: "A bishop that is not blocked by its own pawns", reward: 10 },
    { id: 166, type: "chess", question: "What is 'The Greek Gift' sacrifice?", answer: "Sacrificing a bishop on h7 or h2", aliases: ["greek gift"], reward: 15 },
    { id: 167, type: "chess", question: "Who was the 'Magician from Riga'?", answer: "Mikhail Tal", aliases: ["tal"], reward: 10 },
    { id: 168, type: "chess", question: "Who wrote 'Bobby Fischer Teaches Chess'?", answer: "Bobby Fischer", aliases: ["fischer"], reward: 10 },
    { id: 169, type: "chess", question: "What is the maximum number of queens one side can have?", answer: "9", reward: 10 },
    { id: 170, type: "chess", question: "Which piece is least effective in a closed position?", answer: "Bishop", reward: 10 },
    { id: 171, type: "chess", question: "Which piece is most effective in a closed position?", answer: "Knight", reward: 10 },
    { id: 172, type: "chess", question: "What is the 'King's Indian Attack' setup?", answer: "Nf3, g3, Bg2, d3, O-O, Nbd2", aliases: ["kia"], reward: 15 },
    { id: 173, type: "chess", question: "Which opening starts 1. e4 e5 2. Nf3 Nc6 3. Bb5?", answer: "Ruy Lopez", aliases: ["spanish"], reward: 15 },
    { id: 174, type: "chess", question: "What is the 'Fried Liver Attack'?", answer: "A sacrifice in the Two Knights Defense", aliases: ["fried liver"], reward: 15 },
    { id: 175, type: "chess", question: "What is the 'Traxler Counterattack'?", answer: "A sharp response to the Fried Liver Attack", aliases: ["traxler"], reward: 15 },
    { id: 176, type: "chess", question: "Who is the 'Tiger of Madras'?", answer: "Viswanathan Anand", aliases: ["anand"], reward: 10 },
    { id: 177, type: "chess", question: "What is the 'Berlin Defense'?", answer: "A solid line in the Ruy Lopez", aliases: ["berlin wall"], reward: 15 },
    { id: 178, type: "chess", question: "What is the 'Marshall Attack'?", answer: "A sharp gambit for Black in the Ruy Lopez", aliases: ["marshall gambit"], reward: 15 },
    { id: 179, type: "chess", question: "Who was the first woman to reach the top 10 in world rankings?", answer: "Judit Polgar", aliases: ["polgar"], reward: 10 },
    { id: 180, type: "chess", question: "What is a 'Squeeze' in chess?", answer: "Slowly improving one's position while restricting the opponent", reward: 15 },
    { id: 181, type: "chess", question: "What is the 'Evan's Gambit'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4", aliases: ["evans gambit"], reward: 15 },
    { id: 182, type: "chess", question: "What is the 'King's Gambit Accepted'?", answer: "1. e4 e5 2. f4 exf4", aliases: ["kga"], reward: 15 },
    { id: 183, type: "chess", question: "What is the 'King's Gambit Declined'?", answer: "1. e4 e5 2. f4 d5 or similar", aliases: ["kgd"], reward: 15 },
    { id: 184, type: "chess", question: "Who is the youngest Grandmaster ever (as of 2023)?", answer: "Abhimanyu Mishra", aliases: ["mishra"], reward: 15 },
    { id: 185, type: "chess", question: "What is the 'Bogo-Indian Defense'?", answer: "1. d4 Nf6 2. c4 e6 3. Nf3 Bb4+", aliases: ["bogo indian"], reward: 15 },
    { id: 186, type: "chess", question: "What is the 'Grünfeld Defense'?", answer: "1. d4 Nf6 2. c4 g6 3. Nc3 d5", aliases: ["grunfeld"], reward: 15 },
    { id: 187, type: "chess", question: "What is the 'Catalan Opening'?", answer: "A hybrid of the Queen's Gambit and Reti Opening", aliases: ["catalan"], reward: 15 },
    { id: 188, type: "chess", question: "What is a 'Poisoned Pawn'?", answer: "A pawn that, if taken, leads to positional or tactical ruin", reward: 15 },
    { id: 189, type: "chess", question: "What is 'The Immortal Game'?", answer: "A famous game between Anderssen and Kieseritzky", reward: 15 },
    { id: 190, type: "chess", question: "What is 'The Evergreen Game'?", answer: "A famous game between Anderssen and Dufresne", reward: 15 },
    { id: 191, type: "chess", question: "What is 'The Game of the Century'?", answer: "Byrne vs. Fischer, 1956", reward: 15 },
    { id: 192, type: "chess", question: "What is the 'Smith-Morra Gambit'?", answer: "An aggressive response to the Sicilian Defense", aliases: ["smith morra"], reward: 15 },
    { id: 193, type: "chess", question: "What is the 'Alapin Sicilian'?", answer: "1. e4 c5 2. c3", aliases: ["alapin"], reward: 15 },
    { id: 194, type: "chess", question: "What is the 'Dragon Sicilian'?", answer: "A sharp line in the Sicilian with a kingside fianchetto", aliases: ["dragon"], reward: 15 },
    { id: 195, type: "chess", question: "What is the 'Scheveningen Variation'?", answer: "A solid setup in the Sicilian with pawns on d6 and e6", aliases: ["scheveningen"], reward: 15 },
    { id: 196, type: "chess", question: "What is the 'Taimanov Variation'?", answer: "1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6", aliases: ["taimanov"], reward: 15 },
    { id: 197, type: "chess", question: "What is the 'Kan Variation'?", answer: "1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6", aliases: ["kan"], reward: 15 },
    { id: 198, type: "chess", question: "What is the 'Richter-Rauzer Attack'?", answer: "A sharp line against the Classical Sicilian", aliases: ["richter rauzer"], reward: 15 },
    { id: 199, type: "chess", question: "What is the 'Grand Prix Attack'?", answer: "An aggressive line for White against the Sicilian", aliases: ["grand prix"], reward: 15 },
    { id: 200, type: "chess", question: "What is the 'Closed Sicilian'?", answer: "1. e4 c5 2. Nc3", aliases: ["closed sicilian"], reward: 15 },
    { id: 201, type: "chess", question: "Who was the 'Iron Tigran'?", answer: "Tigran Petrosian", aliases: ["petrosian"], reward: 10 },
    { id: 202, type: "chess", question: "Who was the 'Chess Machine'?", answer: "Jose Raul Capablanca", aliases: ["capablanca"], reward: 10 },
    { id: 203, type: "chess", question: "Who was the 'First American World Champion'?", answer: "Bobby Fischer", aliases: ["fischer"], reward: 10 },
    { id: 204, type: "chess", question: "Who is 'The Beast from Baku'?", answer: "Garry Kasparov", aliases: ["kasparov"], reward: 10 },
    { id: 205, type: "chess", question: "What is 'The Reti Opening'?", answer: "1. Nf3 d5 2. c4", aliases: ["reti"], reward: 15 },
    { id: 206, type: "chess", question: "What is the 'Colle System'?", answer: "A solid opening for White with d4, e3, and Bd3", aliases: ["colle"], reward: 15 },
    { id: 207, type: "chess", question: "What is the 'Torre Attack'?", answer: "A system for White with d4, Nf3, and Bg5", aliases: ["torre"], reward: 15 },
    { id: 208, type: "chess", question: "What is the 'Veresov Attack'?", answer: "1. d4 d5 2. Nc3 Nf6 3. Bg5", aliases: ["veresov"], reward: 15 },
    { id: 209, type: "chess", question: "What is 'The Sokolsky Opening'?", answer: "1. b4", aliases: ["orangutan", "polish opening"], reward: 15 },
    { id: 210, type: "chess", question: "What is 'The Grob'?", answer: "1. g4", aliases: ["grob opening"], reward: 15 },
    { id: 211, type: "chess", question: "What is 'The Bird's Opening'?", answer: "1. f4", aliases: ["birds opening"], reward: 15 },
    { id: 212, type: "chess", question: "What is 'The Nimzo-Larsen Attack'?", answer: "1. b3", aliases: ["larsen opening"], reward: 15 },
    { id: 213, type: "chess", question: "What is the 'Scandinavian Defense'?", answer: "1. e4 d5", aliases: ["center counter"], reward: 15 },
    { id: 214, type: "chess", question: "What is the 'Alekhine's Defense'?", answer: "1. e4 Nf6", aliases: ["alekhine"], reward: 15 },
    { id: 215, type: "chess", question: "What is the 'Caro-Kann Defense'?", answer: "1. e4 c6", aliases: ["caro kann"], reward: 15 },
    { id: 216, type: "chess", question: "What is the 'French Defense'?", answer: "1. e4 e6", aliases: ["french"], reward: 15 },
    { id: 217, type: "chess", question: "What is the 'Pirc Defense'?", answer: "1. e4 d6 2. d4 Nf6", aliases: ["pirc"], reward: 15 },
    { id: 218, type: "chess", question: "What is the 'Modern Defense'?", answer: "1. e4 g6", aliases: ["modern"], reward: 15 },
    { id: 219, type: "chess", question: "What is 'The Hippo'?", answer: "A defensive setup for Black with pawns on a6, b6, d6, e6, g6, h6", aliases: ["hippopotamus"], reward: 15 },
    { id: 220, type: "chess", question: "What is 'The Bongcloud Attack'?", answer: "1. e4 e5 2. Ke2", aliases: ["bongcloud"], reward: 15 },
    { id: 221, type: "chess", question: "Who is the 'Grandmaster of Draw'?", answer: "Anish Giri", aliases: ["giri"], reward: 10 },
    { id: 222, type: "chess", question: "Who is 'Pragg'?", answer: "Rameshbabu Praggnanandhaa", aliases: ["praggnanandhaa"], reward: 10 },
    { id: 223, type: "chess", question: "Who is 'Vidit'?", answer: "Vidit Gujrathi", aliases: ["vidit"], reward: 10 },
    { id: 224, type: "chess", question: "Who is 'Gukesh'?", answer: "Dommaraju Gukesh", aliases: ["gukesh"], reward: 10 },
    { id: 225, type: "chess", question: "Who is 'Ding'?", answer: "Ding Liren", aliases: ["ding liren"], reward: 10 },
    { id: 226, type: "chess", question: "Who is 'Nepo'?", answer: "Ian Nepomniachtchi", aliases: ["nepomniachtchi"], reward: 10 },
    { id: 227, type: "chess", question: "Who is 'Fabi'?", answer: "Fabiano Caruana", aliases: ["caruana"], reward: 10 },
    { id: 228, type: "chess", question: "Who is 'Hikaru'?", answer: "Hikaru Nakamura", aliases: ["nakamura"], reward: 10 },
    { id: 229, type: "chess", question: "Who is 'Levy Rozman'?", answer: "GothamChess", aliases: ["gothamchess", "levy"], reward: 10 },
    { id: 230, type: "chess", question: "What is the 'London System'?", answer: "A solid opening for White with d4, Nf3, and Bf4", aliases: ["london"], reward: 15 },
    { id: 231, type: "chess", question: "What is a 'Fianchetto'?", answer: "Developing a bishop to the long diagonal", reward: 10 },
    { id: 232, type: "chess", question: "What is 'The Center'?", answer: "The e4, d4, e5, and d5 squares", reward: 5 },
    { id: 233, type: "chess", question: "What is a 'Blunder'?", answer: "A very bad move that loses material or the game", reward: 5 },
    { id: 234, type: "chess", question: "What is an 'Inaccuracy'?", answer: "A move that is not the best but not a blunder", reward: 5 },
    { id: 235, type: "chess", question: "What is a 'Mistake'?", answer: "A move that significantly worsens one's position", reward: 5 },
    { id: 236, type: "chess", question: "What is a 'Brilliant' move?", answer: "A difficult-to-find move that wins material or the game", reward: 15 },
    { id: 237, type: "chess", question: "What is 'The Evaluation'?", answer: "A numerical assessment of who is winning", reward: 10 },
    { id: 238, type: "chess", question: "What is '+1.0' in evaluation?", answer: "White is ahead by the equivalent of one pawn", reward: 10 },
    { id: 239, type: "chess", question: "-1.0' in evaluation?", answer: "Black is ahead by the equivalent of one pawn", reward: 10 },
    { id: 240, type: "chess", question: "What is '0.0' in evaluation?", answer: "The position is equal", reward: 5 },
    { id: 241, type: "chess", question: "What is 'M1' in evaluation?", answer: "Mate in one", reward: 15 },
    { id: 242, type: "chess", question: "What is 'The Engine'?", answer: "A computer program that analyzes chess positions", reward: 10 },
    { id: 243, type: "chess", question: "Which engine is currently considered the strongest (as of 2023)?", answer: "Stockfish", aliases: ["stockfish"], reward: 10 },
    { id: 244, type: "chess", question: "Who created 'AlphaZero'?", answer: "Google DeepMind", aliases: ["deepmind", "google"], reward: 15 },
    { id: 245, type: "chess", question: "What is 'Lila Chess Zero'?", answer: "An open-source neural network chess engine", aliases: ["lc0"], reward: 15 },
    { id: 246, type: "chess", question: "What is 'Chess.com'?", answer: "The largest online chess platform", aliases: ["chesscom"], reward: 5 },
    { id: 247, type: "chess", question: "What is 'Lichess'?", answer: "A free and open-source online chess platform", aliases: ["lichess.org"], reward: 5 },
    { id: 248, type: "chess", question: "What is 'The Candidates Tournament'?", answer: "The tournament that decides the challenger for the World Title", aliases: ["candidates"], reward: 15 },
    { id: 249, type: "chess", question: "What is 'The Olympiad'?", answer: "A biennial chess tournament for national teams", aliases: ["chess olympiad"], reward: 15 },
    { id: 250, type: "chess", question: "What is 'The World Cup'?", answer: "A large knockout tournament organized by FIDE", aliases: ["fide world cup"], reward: 15 },
    { id: 251, type: "chess", question: "What is 'The Grand Chess Tour'?", answer: "A series of elite chess tournaments", aliases: ["gct"], reward: 15 },
    { id: 252, type: "chess", question: "What is 'The Champions Chess Tour'?", answer: "An online series of elite tournaments", aliases: ["cct"], reward: 15 },
    { id: 253, type: "chess", question: "Who is 'The Big Greek'?", answer: "Georgios Souleidis", aliases: ["souleidis"], reward: 10 },
    { id: 254, type: "chess", question: "Who is 'Agadmator'?", answer: "Antonio Radić", aliases: ["radic"], reward: 10 },
    { id: 255, type: "chess", question: "Who is 'GingerGM'?", answer: "Simon Williams", aliases: ["simon williams"], reward: 10 },
    { id: 256, type: "chess", question: "Who is 'Chessbrah'?", answer: "Eric Hansen and Aman Hambleton", aliases: ["eric hansen", "aman hambleton"], reward: 10 },
    { id: 257, type: "chess", question: "Who is 'BotezLive'?", answer: "Alexandra and Andrea Botez", aliases: ["alexandra botez", "andrea botez"], reward: 10 },
    { id: 258, type: "chess", question: "Who is 'Anna Cramling'?", answer: "A popular chess streamer and daughter of Pia Cramling", aliases: ["cramling"], reward: 10 },
    { id: 259, type: "chess", question: "Who is 'Pia Cramling'?", answer: "A legendary female Grandmaster from Sweden", aliases: ["pia"], reward: 10 },
    { id: 260, type: "chess", question: "What is 'The Scotch Gambit'?", answer: "1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Bc4", aliases: ["scotch gambit"], reward: 15 },
    { id: 261, type: "chess", question: "What is 'The Danish Gambit'?", answer: "1. e4 e5 2. d4 exd4 3. c3", aliases: ["danish gambit"], reward: 15 },
    { id: 262, type: "chess", question: "What is 'The Belgrade Gambit'?", answer: "A line in the Four Knights Game", aliases: ["belgrade gambit"], reward: 15 },
    { id: 263, type: "chess", question: "What is 'The Göring Gambit'?", answer: "A sharp line in the Scotch Game", aliases: ["goring gambit"], reward: 15 },
    { id: 264, type: "chess", question: "What is 'The Halloween Gambit'?", answer: "A dubious but fun sacrifice in the Four Knights Game", aliases: ["halloween gambit"], reward: 15 },
    { id: 265, type: "chess", question: "What is 'The Elephant Gambit'?", answer: "1. e4 e5 2. Nf3 d5", aliases: ["elephant gambit"], reward: 15 },
    { id: 266, type: "chess", question: "What is 'The Latvian Gambit'?", answer: "1. e4 e5 2. Nf3 f5", aliases: ["latvian gambit"], reward: 15 },
    { id: 267, type: "chess", question: "What is 'The Stafford Gambit'?", answer: "A popular online gambit in the Petroff Defense", aliases: ["stafford gambit"], reward: 15 },
    { id: 268, type: "chess", question: "What is 'The Englund Gambit'?", answer: "1. d4 e5", aliases: ["englund gambit"], reward: 15 },
    { id: 269, type: "chess", question: "What is 'The Blackmar-Diemer Gambit'?", answer: "1. d4 d5 2. e4", aliases: ["bdg"], reward: 15 },
    { id: 270, type: "chess", question: "What is 'The Albin Countergambit'?", answer: "1. d4 d5 2. c4 e5", aliases: ["albin countergambit"], reward: 15 },
    { id: 271, type: "chess", question: "What is 'The Benko Gambit'?", answer: "1. d4 Nf6 2. c4 c5 3. d5 b5", aliases: ["benko"], reward: 15 },
    { id: 272, type: "chess", question: "What is 'The Wolga Gambit'?", answer: "Another name for the Benko Gambit", aliases: ["wolga"], reward: 15 },
    { id: 273, type: "chess", question: "What is 'The Blumenfeld Gambit'?", answer: "1. d4 Nf6 2. c4 e6 3. Nf3 c5 4. d5 b5", aliases: ["blumenfeld"], reward: 15 },
    { id: 274, type: "chess", question: "What is 'The Schliemann Defense'?", answer: "A sharp gambit for Black in the Ruy Lopez with 3... f5", aliases: ["schliemann"], reward: 15 },
    { id: 275, type: "chess", question: "What is 'The Steinitz Defense'?", answer: "A solid line in the Ruy Lopez with 3... d6", aliases: ["steinitz defense"], reward: 15 },
    { id: 276, type: "chess", question: "What is 'The Cozio Defense'?", answer: "A line in the Ruy Lopez with 3... Nge7", aliases: ["cozio"], reward: 15 },
    { id: 277, type: "chess", question: "What is 'The Smyslov Defense'?", answer: "A line in the Ruy Lopez with 3... g6", aliases: ["smyslov defense"], reward: 15 },
    { id: 278, type: "chess", question: "What is 'The Bird's Defense'?", answer: "A line in the Ruy Lopez with 3... Nd4", aliases: ["birds defense"], reward: 15 },
    { id: 279, type: "chess", question: "What is 'The Classical Defense'?", answer: "A line in the Ruy Lopez with 3... Bc5", aliases: ["classical defense"], reward: 15 },
    { id: 280, type: "chess", question: "What is 'The Norwegian Defense'?", answer: "A line in the Ruy Lopez with 3... Na5", aliases: ["norwegian defense"], reward: 15 },
    { id: 281, type: "chess", question: "What is 'The Exchange Ruy Lopez'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6", aliases: ["exchange ruy lopez"], reward: 15 },
    { id: 282, type: "chess", question: "What is 'The Open Ruy Lopez'?", answer: "A line in the Ruy Lopez where Black plays 5... Nxe4", aliases: ["open ruy lopez"], reward: 15 },
    { id: 283, type: "chess", question: "What is 'The Archangel Variation'?", answer: "A sharp line in the Ruy Lopez with ...Bc5 and ...Bb7", aliases: ["archangel"], reward: 15 },
    { id: 284, type: "chess", question: "What is 'The Moller Defense'?", answer: "A line in the Ruy Lopez with 5... Bc5", aliases: ["moller"], reward: 15 },
    { id: 285, type: "chess", question: "What is 'The Chigorin Variation'?", answer: "A classic line in the Closed Ruy Lopez", aliases: ["chigorin"], reward: 15 },
    { id: 286, type: "chess", question: "What is 'The Breyer Variation'?", answer: "A creative line in the Closed Ruy Lopez with 9... Nb8", aliases: ["breyer"], reward: 15 },
    { id: 287, type: "chess", question: "What is 'The Zaitsev Variation'?", answer: "A popular line in the Closed Ruy Lopez with 9... Bb7", aliases: ["zaitsev"], reward: 15 },
    { id: 288, type: "chess", question: "What is 'The Karpov Variation'?", answer: "A solid line in the Closed Ruy Lopez", aliases: ["karpov variation"], reward: 15 },
    { id: 289, type: "chess", question: "What is 'The Worrall Attack'?", answer: "A line in the Ruy Lopez with 6. Qe2", aliases: ["worrall"], reward: 15 },
    { id: 290, type: "chess", question: "What is 'The Keres Variation'?", answer: "A sharp line in the Closed Ruy Lopez", aliases: ["keres variation"], reward: 15 },
    { id: 291, type: "chess", question: "Who is 'The Gentleman of Chess'?", answer: "Boris Spassky", aliases: ["spassky"], reward: 10 },
    { id: 292, type: "chess", question: "Who is 'The Patriarch'?", answer: "Mikhail Botvinnik", aliases: ["botvinnik"], reward: 10 },
    { id: 293, type: "chess", question: "Who is 'The Smothered Mate King'?", answer: "Greco", aliases: ["greco"], reward: 10 },
    { id: 294, type: "chess", question: "Who is 'The Father of Modern Chess'?", answer: "Wilhelm Steinitz", aliases: ["steinitz"], reward: 10 },
    { id: 295, type: "chess", question: "What is 'The Italian Game'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bc4", aliases: ["italian"], reward: 15 },
    { id: 296, type: "chess", question: "What is 'The Evans Gambit'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4", aliases: ["evans"], reward: 15 },
    { id: 297, type: "chess", question: "What is 'The Two Knights Defense'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6", aliases: ["two knights"], reward: 15 },
    { id: 298, type: "chess", question: "What is 'The Giuoco Piano'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5", aliases: ["giuoco piano"], reward: 15 },
    { id: 299, type: "chess", question: "What is 'The Giuoco Pianissimo'?", answer: "A very slow version of the Italian Game with d3", aliases: ["giuoco pianissimo"], reward: 15 },
    { id: 300, type: "chess", question: "What is 'The Four Knights Game'?", answer: "1. e4 e5 2. Nf3 Nc6 3. Nc3 Nf6", aliases: ["four knights"], reward: 15 },
    { id: 161, type: "chess", question: "Name the opening: 1. e4 Nf6.", answer: "Alekhine Defense", aliases: ["alekhine"], reward: 15 },
    { id: 162, type: "chess", question: "Name the opening: 1. e4 Nc6.", answer: "Nimzowitsch Defense", aliases: ["nimzowitsch"], reward: 15 },
    { id: 163, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. d3.", answer: "King's Pawn, Old Italian", aliases: ["old italian"], reward: 15 },
    { id: 164, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nf6.", answer: "Petrov Defense", aliases: ["russian"], reward: 15 },
    { id: 165, type: "chess", question: "Name the opening: 1. e4 e5 2. Qh5.", answer: "Parham Attack", aliases: ["parham"], reward: 10 },
    { id: 166, type: "chess", question: "Name the opening: 1. e4 e5 2. Qf3.", answer: "Wayward Queen Attack", aliases: ["wayward queen"], reward: 10 },
    { id: 167, type: "chess", question: "Name the opening: 1. e4 d5 2. exd5 Qxd5 3. Nc3.", answer: "Scandinavian Defense, Mieses-Kotrc", aliases: ["scandi"], reward: 15 },
    { id: 168, type: "chess", question: "Name the opening: 1. d4 d5 2. c4 dxc4.", answer: "Queen's Gambit Accepted", aliases: ["qga"], reward: 15 },
    { id: 169, type: "chess", question: "Name the opening: 1. d4 d5 2. c4 e5.", answer: "Albin Counter-Gambit", aliases: ["albin"], reward: 15 },
    { id: 170, type: "chess", question: "Name the opening: 1. e4 c5 2. Nf3 Nc6 3. Bb5.", answer: "Sicilian Rossolimo", aliases: ["rossolimo"], reward: 15 },
    { id: 171, type: "chess", question: "Name the opening: 1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 g6.", answer: "Sicilian Dragon", aliases: ["dragon"], reward: 15 },
    { id: 172, type: "chess", question: "Name the opening: 1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 a6.", answer: "Sicilian Kan", aliases: ["kan"], reward: 15 },
    { id: 173, type: "chess", question: "Name the opening: 1. e4 c5 2. Nf3 e6 3. d4 cxd4 4. Nxd4 Nc6.", answer: "Sicilian Taimanov", aliases: ["taimanov"], reward: 15 },
    { id: 174, type: "chess", question: "Name the opening: 1. e4 c5 2. Nf3 d6 3. c3.", answer: "Sicilian Alapin", aliases: ["alapin"], reward: 15 },
    { id: 175, type: "chess", question: "Name the tactic: attack along the long diagonal a1-h8 or h1-a8.", answer: "Diagonal attack", reward: 10 },
    { id: 176, type: "chess", question: "Name the tactic: mating net around the king.", answer: "Mating net", reward: 10 },
    { id: 177, type: "chess", question: "Name the tactic: push passed pawn supported by pieces.", answer: "Pawn push", reward: 10 },
    { id: 178, type: "chess", question: "Name the tactic: simplify to winning endgame.", answer: "Simplification", reward: 10 },
    { id: 179, type: "chess", question: "Name the tactic: exchange into favorable structure.", answer: "Structural transformation", reward: 10 },
    { id: 180, type: "chess", question: "What is the best piece in open positions?", answer: "Bishop", reward: 10 },
    { id: 181, type: "chess", question: "What is the best piece in closed positions?", answer: "Knight", reward: 10 },
    { id: 182, type: "chess", question: "What is the main principle of two weaknesses?", answer: "Create a second front to overload defense", reward: 15 },
    { id: 183, type: "chess", question: "Name the defense system with pawns on d6/e5/f7 and g6.", answer: "Pirc/Modern setup", reward: 10 },
    { id: 184, type: "chess", question: "Name the sacrifice on b5/b4 to open files in Sicilian.", answer: "Exchange sacrifice on c3", aliases: ["xc3 sac"], reward: 15 },
    { id: 185, type: "chess", question: "Name the tactic: capturing on h7/h2 to drag king out.", answer: "Bishop sacrifice on h7/h2", reward: 15 },
    { id: 186, type: "chess", question: "Name the endgame: king and pawn vs king key technique.", answer: "Opposition and square of the pawn", reward: 15 },
    { id: 187, type: "chess", question: "Name the ending: rook and bishop vs rook is usually a draw.", answer: "Rook and bishop vs rook draw", reward: 15 },
    { id: 188, type: "chess", question: "Name the ending: rook and knight vs rook drawish?", answer: "Rook and knight vs rook often draw", reward: 15 },
    { id: 189, type: "chess", question: "Name the ending: queen vs rook with poor king placement is winning for queen.", answer: "Queen vs rook win", reward: 15 },
    { id: 190, type: "chess", question: "Name the tactic: interference on defensive line.", answer: "Interference", reward: 10 },
    { id: 191, type: "chess", question: "Name the tactic: sacrifice to remove king safety.", answer: "King hunt", reward: 10 },
    { id: 192, type: "chess", question: "Name the tactic: clearing a file for rook penetration.", answer: "File clearance", reward: 10 },
    { id: 193, type: "chess", question: "Name the tactic: delaying recapture to play a stronger move.", answer: "Intermediate move", aliases: ["zwischenzug"], reward: 15 },
    { id: 194, type: "chess", question: "Name the tactic: mate threats that force a win of material.", answer: "Mating threats", reward: 10 },
    { id: 195, type: "chess", question: "Name the tactic: pin and win a piece.", answer: "Pin tactic", reward: 10 },
    { id: 196, type: "chess", question: "Name the tactic: skewer to win major piece.", answer: "Skewer tactic", reward: 10 },
    { id: 197, type: "chess", question: "Name the tactic: discovered attack on queen.", answer: "Discovered attack", reward: 10 },
    { id: 198, type: "chess", question: "Name the tactic: fork with knight on queen and rook.", answer: "Knight fork", reward: 10 },
    { id: 199, type: "chess", question: "Name the tactic: back rank mating pattern", answer: "Back rank mate", reward: 10 },
    { id: 200, type: "chess", question: "Name the opening strategy: put pressure on d4 in Sicilian.", answer: "Pressure on d4", reward: 10 },
    { id: 201, type: "chess", question: "Name the opening strategy: advance e5 in French to gain space.", answer: "Space advantage", reward: 10 },
    { id: 202, type: "chess", question: "Name the opening strategy: break with c4 in Queen's Gambit structures.", answer: "c4 break", reward: 10 },
    { id: 203, type: "chess", question: "Name the player known for King's Indian mastery.", answer: "Garry Kasparov", aliases: ["kasparov"], reward: 10 },
    { id: 204, type: "chess", question: "Who wrote 'Chess Fundamentals'?", answer: "Jose Raul Capablanca", aliases: ["capablanca"], reward: 15 },
    { id: 205, type: "chess", question: "Which player is called the 'The Magician from Riga'?", answer: "Mikhail Tal", aliases: ["tal"], reward: 10 },
    { id: 206, type: "chess", question: "Which world champion was a concert pianist?", answer: "Mark Taimanov", aliases: ["taimanov"], reward: 20 },
    { id: 207, type: "chess", question: "Which piece is usually best for blockading a passed pawn?", answer: "Knight", reward: 10 },
    { id: 208, type: "chess", question: "What is the Lucena Position?", answer: "Winning rook endgame setup with a bridge", aliases: ["lucena"], reward: 15 },
    { id: 209, type: "chess", question: "What is the Philidor Position in rook endgames?", answer: "Defensive setup for a draw", aliases: ["philidor"], reward: 15 },
    { id: 210, type: "chess", question: "What is a 'fianchetto'?", answer: "Developing a bishop to the long diagonal", reward: 10 },
    { id: 211, type: "chess", question: "What is the name of the squares e4, d4, e5, d5?", answer: "The center", reward: 5 },
    { id: 212, type: "chess", question: "What is the name of the opening 1. e4 c6?", answer: "Caro-Kann Defense", aliases: ["caro kann"], reward: 10 },
    { id: 213, type: "chess", question: "Which piece can move over other pieces?", answer: "Knight", reward: 5 },
    { id: 214, type: "chess", question: "What is it called when a player can't make any legal moves but isn't in check?", answer: "Stalemate", reward: 10 },
    { id: 215, type: "chess", question: "Who was the first woman to earn the title of Grandmaster?", answer: "Nona Gaprindashvili", reward: 20 },
    { id: 216, type: "chess", question: "What is a 'poisoned pawn'?", answer: "A pawn that looks free but leads to trouble if taken", reward: 15 },
    { id: 217, type: "chess", question: "What is the maximum number of queens one side can have?", answer: "9", reward: 10 },
    { id: 218, type: "chess", question: "What is the '50-move rule'?", answer: "Draw if 50 moves pass without a capture or pawn move", reward: 15 },
    { id: 219, type: "chess", question: "Which piece is worth the most points?", answer: "Queen", reward: 5 },
    { id: 220, type: "chess", question: "How many points is a rook worth?", answer: "5", reward: 5 },
    { id: 221, type: "chess", question: "How many points is a knight worth?", answer: "3", reward: 5 },
    { id: 222, type: "chess", question: "What is the 'Scholar's Mate'?", answer: "A checkmate in 4 moves", reward: 10 },
    { id: 223, type: "chess", question: "What is a 'skewer'?", answer: "Attacking a valuable piece to win one behind it", reward: 10 },
    { id: 224, type: "chess", question: "What is a 'pin'?", answer: "Attacking a piece so it can't move without exposing a better one", reward: 10 },
    { id: 225, type: "chess", question: "What is a 'fork'?", answer: "One piece attacking two or more at once", reward: 10 },
    { id: 226, type: "chess", question: "Which piece is the only one that can't move backward?", answer: "Pawn", reward: 5 },
    { id: 227, type: "chess", question: "What is 'en passant'?", answer: "A special pawn capture move", reward: 15 },
    { id: 228, type: "chess", question: "What is 'castling'?", answer: "A move involving the king and a rook", reward: 10 },
    { id: 229, type: "chess", question: "What is the 'Sicilian Defense'?", answer: "An opening starting with 1. e4 c5", reward: 10 },
    { id: 230, type: "chess", question: "Who is the current World Chess Champion (as of 2024)?", answer: "Ding Liren", reward: 10 },
    { id: 231, type: "chess", question: "Who won the 2024 Candidates Tournament?", answer: "Gukesh D", reward: 15 },
    { id: 232, type: "chess", question: "What is the name of the machine that beat Garry Kasparov?", answer: "Deep Blue", reward: 15 },
    { id: 233, type: "chess", question: "What is the rating needed to be a Grandmaster?", answer: "2500", reward: 15 },
    { id: 234, type: "chess", question: "What is 'bullet' chess?", answer: "Chess with less than 3 minutes for each player", reward: 10 },
    { id: 235, type: "chess", question: "What is 'blitz' chess?", answer: "Chess with 3 to 10 minutes for each player", reward: 10 },
    { id: 236, type: "chess", question: "What is the 'French Defense'?", answer: "An opening starting with 1. e4 e6", reward: 10 },
    { id: 237, type: "chess", question: "What is the 'King's Gambit'?", answer: "An opening starting with 1. e4 e5 2. f4", reward: 15 },
    { id: 238, type: "chess", question: "Which piece is called a 'minor piece'?", answer: "Knight or Bishop", reward: 10 },
    { id: 239, type: "chess", question: "Which piece is called a 'major piece'?", answer: "Rook or Queen", reward: 10 },
    { id: 240, type: "chess", question: "What is the name of the squares a1, h1, a8, h8?", answer: "The corners", reward: 5 },
    { id: 241, type: "chess", question: "What is 'promotion'?", answer: "A pawn reaching the 8th rank", reward: 10 },
    { id: 242, type: "chess", question: "How many squares does a king move at a time?", answer: "1", reward: 5 },
    { id: 243, type: "chess", question: "Which piece is known for its L-shape move?", answer: "Knight", reward: 5 },
    { id: 244, type: "chess", question: "What is the 'Ruy Lopez'?", answer: "An opening starting with 1. e4 e5 2. Nf3 Nc6 3. Bb5", reward: 15 },
    { id: 245, type: "chess", question: "Who is 'The Pride and Sorrow of Chess'?", answer: "Paul Morphy", reward: 20 },
    { id: 246, type: "chess", question: "What is a 'passed pawn'?", answer: "A pawn with no enemy pawns in front of it", reward: 10 },
    { id: 247, type: "chess", question: "What is 'zugzwang'?", answer: "A situation where any move weakens your position", reward: 15 },
    { id: 248, type: "chess", question: "What is 'prophylaxis'?", answer: "Moving to prevent an opponent's plan", reward: 15 },
    { id: 249, type: "chess", question: "What is 'threefold repetition'?", answer: "A draw when the same position occurs 3 times", reward: 15 },
    { id: 250, type: "chess", question: "How many squares are on a chessboard?", answer: "64", reward: 5 },
    { id: 251, type: "chess", question: "What is the color of the square h1?", answer: "White", reward: 5 },
    { id: 252, type: "chess", question: "What is the color of the square a1?", answer: "Black", reward: 5 },
    { id: 253, type: "chess", question: "Who was world champion from 1927 to 1935?", answer: "Alexander Alekhine", reward: 20 },
    { id: 254, type: "chess", question: "Which player was nicknamed 'The Iron Tigran'?", answer: "Tigran Petrosian", reward: 15 },
    { id: 255, type: "chess", question: "Who is known as the father of modern chess?", answer: "Wilhelm Steinitz", reward: 15 },
    { id: 256, type: "chess", question: "What is the name of the square f2 for White?", answer: "Weak square", aliases: ["weak square f2"], reward: 10 },
    { id: 257, type: "chess", question: "Which opening starts with 1. Nf3?", answer: "Reti Opening", reward: 15 },
    { id: 258, type: "chess", question: "Which opening starts with 1. c4?", answer: "English Opening", reward: 15 },
    { id: 259, type: "chess", question: "What is the 'Dragon' variation a part of?", answer: "Sicilian Defense", reward: 15 },
    { id: 260, type: "chess", question: "Who is the youngest Grandmaster ever (as of 2024)?", answer: "Abhimanyu Mishra", reward: 15 },
    { id: 261, type: "chess", question: "Which piece is usually traded for two minor pieces?", answer: "Rook", reward: 15 },
    { id: 262, type: "chess", question: "What is 'material advantage'?", answer: "Having more or better pieces than the opponent", reward: 10 },
    { id: 263, type: "chess", question: "What is a 'discovered attack'?", answer: "Moving one piece to reveal an attack by another", reward: 15 },
    { id: 264, type: "chess", question: "What is a 'double check'?", answer: "Checking the king with two pieces at once", reward: 15 },
    { id: 265, type: "chess", question: "Which piece is best at stopping passed pawns?", answer: "Blockader (usually Knight or King)", reward: 10 },
    { id: 266, type: "chess", question: "What is the 'square of the pawn' used for?", answer: "Calculating if a king can catch a pawn", reward: 15 },
    { id: 267, type: "chess", question: "What is 'opposition' in king endgames?", answer: "Kings facing each other with one square between", reward: 15 },
    { id: 268, type: "chess", question: "What is 'triangulation'?", answer: "A king maneuver to lose a tempo and gain opposition", reward: 20 },
    { id: 269, type: "chess", question: "What is 'underpromotion'?", answer: "Promoting to something other than a queen", reward: 15 },
    { id: 270, type: "chess", question: "Which piece is most effective in a 'closed' position?", answer: "Knight", reward: 10 },
    { id: 271, type: "chess", question: "Which piece is most effective in an 'open' position?", answer: "Bishop", reward: 10 },
    { id: 272, type: "chess", question: "What is a 'bad bishop'?", answer: "A bishop blocked by its own pawns", reward: 10 },
    { id: 273, type: "chess", question: "What is the 'center' in hypermodern chess?", answer: "Controlled by pieces rather than occupied by pawns", reward: 15 },
    { id: 274, type: "chess", question: "Who won the World Chess Championship in 1972?", answer: "Bobby Fischer", reward: 10 },
    { id: 275, type: "chess", question: "What is 'The Immortal Game'?", answer: "Anderssen vs Kieseritzky, 1851", reward: 20 },
    { id: 276, type: "chess", question: "What is 'The Evergreen Game'?", answer: "Anderssen vs Dufresne, 1852", reward: 20 },
    { id: 277, type: "chess", question: "Who is known for the 'Game of the Century'?", answer: "Bobby Fischer", reward: 20 },
    { id: 278, type: "chess", question: "What is the name of the software used for chess analysis?", answer: "Engine", aliases: ["stockfish", "lc0"], reward: 10 },
    { id: 279, type: "chess", question: "What is 'Premove'?", answer: "Making a move before the opponent has moved", reward: 5 },
    { id: 280, type: "chess", question: "What is 'Touch-move rule'?", answer: "If you touch a piece, you must move it", reward: 10 },
    { id: 281, type: "chess", question: "What is 'Time control'?", answer: "The amount of time each player has", reward: 10 },
    { id: 282, type: "chess", question: "What is 'Adjournment'?", answer: "Pausing a game to continue later (old rule)", reward: 15 },
    { id: 283, type: "chess", question: "What is 'Simultaneous exhibition'?", answer: "One player playing many others at once", reward: 15 },
    { id: 284, type: "chess", question: "What is 'Blindfold chess'?", answer: "Playing without looking at the board", reward: 20 },
    { id: 285, type: "chess", question: "Who is the strongest female chess player of all time?", answer: "Judit Polgar", reward: 15 },
    { id: 286, type: "chess", question: "What is the 'King's Indian Defense'?", answer: "1. d4 Nf6 2. c4 g6 3. Nc3 Bg7", reward: 15 },
    { id: 287, type: "chess", question: "What is the 'Nimzo-Indian Defense'?", answer: "1. d4 Nf6 2. c4 e6 3. Nc3 Bb4", reward: 15 },
    { id: 288, type: "chess", question: "What is the 'Grünfeld Defense'?", answer: "1. d4 Nf6 2. c4 g6 3. Nc3 d5", reward: 15 },
    { id: 289, type: "chess", question: "What is the 'Slav Defense'?", answer: "1. d4 d5 2. c4 c6", reward: 15 },
    { id: 290, type: "chess", question: "What is the 'Scandinavian Defense'?", answer: "1. e4 d5", reward: 15 },
    { id: 291, type: "chess", question: "What is the 'Alekhine Defense'?", answer: "1. e4 Nf6", reward: 15 },
    { id: 292, type: "chess", question: "What is the 'Modern Defense'?", answer: "1. e4 g6", reward: 15 },
    { id: 293, type: "chess", question: "What is 'FIDE'?", answer: "International Chess Federation", reward: 10 },
    { id: 294, type: "chess", question: "What is 'Grandmaster' (GM)?", answer: "The highest title in chess", reward: 10 },
    { id: 295, type: "chess", question: "What is 'International Master' (IM)?", answer: "A title below Grandmaster", reward: 10 },
    { id: 296, type: "chess", question: "What is 'FIDE Master' (FM)?", answer: "A title below International Master", reward: 10 },
    { id: 297, type: "chess", question: "What is 'Candidate Master' (CM)?", answer: "A title below FIDE Master", reward: 10 },
    { id: 298, type: "chess", question: "How many world champions have there been (official)?", answer: "17", reward: 15 },
    { id: 299, type: "chess", question: "What is the name of the square e1 for White?", answer: "King's starting square", reward: 5 },
    { id: 300, type: "chess", question: "What is the name of the square d1 for White?", answer: "Queen's starting square", reward: 5 },
    // Football Questions (301-600)
    { id: 301, type: 'football', question: "Who has won the most Ballon d'Or awards?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
    { id: 204, type: "chess", question: "Name the player known as the Wizard of Riga.", answer: "Mikhail Tal", aliases: ["tal"], reward: 10 },
    { id: 205, type: "chess", question: "Name the player known for deep strategy and endgames.", answer: "Jose Raul Capablanca", aliases: ["capablanca"], reward: 10 },
    { id: 206, type: "chess", question: "Name the player who authored 'How to Reassess Your Chess'.", answer: "Jeremy Silman", aliases: ["silman"], reward: 10 },
    { id: 207, type: "chess", question: "Name the tournament: Candidates determines challenger for world title.", answer: "Candidates Tournament", aliases: ["candidates"], reward: 10 },
    { id: 208, type: "chess", question: "Name the defense with black playing ...e5 against 1. d4.", answer: "Budapest Gambit", reward: 15 },
    { id: 209, type: "chess", question: "Name the defense with black playing ...c5 vs 1. d4.", answer: "Benoni Defense", reward: 15 },
    { id: 210, type: "chess", question: "Name the defense featuring ...b6 and ...Bb7 vs 1. e4.", answer: "Owen's Defense", reward: 15 },
    { id: 211, type: "chess", question: "Name the endgame concept: 'rule of the square'.", answer: "Square of the pawn", reward: 15 },
    { id: 212, type: "chess", question: "Name the basic mating pattern with two bishops.", answer: "Two bishops mate", reward: 15 },
    { id: 213, type: "chess", question: "Name the principle: don't move pawns in front of your king unnecessarily.", answer: "King safety", reward: 10 },
    { id: 214, type: "chess", question: "Name the principle: centralize your pieces.", answer: "Centralization", reward: 10 },
    { id: 215, type: "chess", question: "Name the principle: avoid placing knights on the rim.", answer: "Knight on the rim is dim", reward: 10 },
    { id: 216, type: "chess", question: "Name the principle: rooks belong behind passed pawns.", answer: "Rooks behind passed pawns", reward: 10 },
    { id: 217, type: "chess", question: "Name the principle: opposite side castling often leads to pawn storms.", answer: "Opposite side castling", reward: 10 },
    { id: 218, type: "chess", question: "Name the principle: don't grab poisoned pawns.", answer: "Poisoned pawn", reward: 10 },
    { id: 219, type: "chess", question: "Name the Sicilian line with Qb6 hitting b2.", answer: "Poisoned Pawn Najdorf", aliases: ["poisoned pawn"], reward: 15 },
    { id: 220, type: "chess", question: "Name the defense: 1. e4 d6 2. d4 Nf6 3. Nc3 g6.", answer: "Pirc Defense", reward: 15 },
    { id: 221, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6.", answer: "Two Knights Defense", aliases: ["two knights"], reward: 15 },
    { id: 222, type: "chess", question: "Name the trap in the Two Knights with Ng5 and Bxf7+.", answer: "Fried Liver Attack", aliases: ["fried liver"], reward: 15 },
    { id: 223, type: "chess", question: "Name the declined version avoiding fried liver: 3...d6.", answer: "Steinitz Defense", aliases: ["steinitz"], reward: 10 },
    { id: 224, type: "chess", question: "Name the tactic: attacking pinned knight on f6 in Sicilian.", answer: "Pin and pressure", reward: 10 },
    { id: 225, type: "chess", question: "Name the tactic: queen sacrifice leading to forced mate.", answer: "Queen sacrifice mate", reward: 15 },
    { id: 226, type: "chess", question: "Name the endgame: rook vs rook with extra pawn typically winning.", answer: "Lucena position", aliases: ["lucena"], reward: 15 },
    { id: 227, type: "chess", question: "Name the defensive endgame method building a bridge.", answer: "Lucena technique", reward: 15 },
    { id: 228, type: "chess", question: "Name the defensive endgame fortress against rook ending.", answer: "Philidor position", aliases: ["philidor position"], reward: 15 },
    { id: 229, type: "chess", question: "Name the concept: second rank weakness around your king.", answer: "Back rank weakness", reward: 10 },
    { id: 230, type: "chess", question: "Name the motif: knight outpost on d5 in Sicilian structures.", answer: "d5 outpost", reward: 10 },
    { id: 231, type: "chess", question: "Name the motif: pawn break f4/f5 in King’s Indian.", answer: "f-pawn break", reward: 10 },
    { id: 232, type: "chess", question: "Name the motif: c5 break in French to hit d4.", answer: "c5 break", reward: 10 },
    { id: 233, type: "chess", question: "Name the motif: e4/e5 break to open center.", answer: "Center break", reward: 10 },
    { id: 234, type: "chess", question: "Name the motif: long castle opposite side attack.", answer: "Pawn storm", reward: 10 },
    { id: 235, type: "chess", question: "Name the motif: rook lift along the third rank.", answer: "Rook lift", reward: 10 },
    { id: 236, type: "chess", question: "Name the motif: exchange sacrifice on c3 in Sicilian.", answer: "Exchange sac on c3", reward: 15 },
    { id: 237, type: "chess", question: "Name the motif: bishop sacrifice on h7 for attack.", answer: "Greek gift", reward: 15 },
    { id: 238, type: "chess", question: "Name the motif: knight sacrifice on f7/f2.", answer: "Knight sacrifice on f7", reward: 15 },
    { id: 239, type: "chess", question: "Name the motif: rook sacrifice on h8/h1 for attack.", answer: "Rook sacrifice", reward: 15 },
    { id: 240, type: "chess", question: "Name the motif: clearance of g-file for rook attack.", answer: "g-file clearance", reward: 10 },
    { id: 241, type: "chess", question: "Name the motif: bishop on long diagonal b1-h7 attack.", answer: "Long diagonal attack", reward: 10 },
    { id: 242, type: "chess", question: "Name the motif: queen and knight attack on h7/h2.", answer: "Q+N attack", reward: 10 },
    { id: 243, type: "chess", question: "Name the motif: mating net with queen and rook.", answer: "Queen-rook mate", reward: 10 },
    { id: 244, type: "chess", question: "Name the motif: mating net with rook rook (ladder).", answer: "Ladder mate", reward: 10 },
    { id: 245, type: "chess", question: "Name the motif: discovered attack with bishop and rook.", answer: "Discovered attack", reward: 10 },
    { id: 246, type: "chess", question: "Name the motif: remove the guard and win material.", answer: "Deflection", reward: 10 },
    { id: 247, type: "chess", question: "Name the motif: trapping a piece with pawns.", answer: "Trapping", reward: 10 },
    { id: 248, type: "chess", question: "Name the motif: overprotecting a strong square.", answer: "Overprotection", reward: 10 },
    { id: 249, type: "chess", question: "Name the motif: break with b4/b5 in queenside structures.", answer: "Queenside pawn break", reward: 10 },
    { id: 250, type: "chess", question: "Name the motif: break with f4/f5 in kingside structures.", answer: "Kingside pawn break", reward: 10 },
    { id: 251, type: "chess", question: "Name the motif: rook on open file penetrates to 7th.", answer: "Rook penetration", reward: 10 },
    { id: 252, type: "chess", question: "Name the motif: double rooks on a file.", answer: "Rook doubling", reward: 10 },
    { id: 253, type: "chess", question: "Name the motif: queen-side minority attack in Carlsbad.", answer: "Minority attack", reward: 15 },
    { id: 254, type: "chess", question: "Name the motif: bishop pair advantage.", answer: "Bishop pair", reward: 10 },
    { id: 255, type: "chess", question: "Name the motif: knight vs bad bishop in closed positions.", answer: "Good knight vs bad bishop", reward: 10 },
    { id: 256, type: "chess", question: "Name the motif: rook behind passed pawn.", answer: "Rook behind passed pawn", reward: 10 },
    { id: 257, type: "chess", question: "Name the motif: king activity in endgame.", answer: "Active king", reward: 10 },
    { id: 258, type: "chess", question: "Name the motif: triangulation to win tempo.", answer: "Triangulation", reward: 15 },
    { id: 259, type: "chess", question: "Name the motif: zugzwang to force concessions.", answer: "Zugzwang", reward: 15 },
    { id: 260, type: "chess", question: "Name the motif: perpetual check to draw.", answer: "Perpetual check", reward: 15 },
    { id: 261, type: "chess", question: "Name the motif: stalemate resource to draw.", answer: "Stalemate", reward: 15 },
    { id: 262, type: "chess", question: "Name the motif: fortress to hold a draw.", answer: "Fortress", reward: 15 },
    { id: 263, type: "chess", question: "Name the motif: squeeze technique improving positions slowly.", answer: "Positional squeeze", reward: 10 },
    { id: 264, type: "chess", question: "Name the motif: prophylaxis preventing opponent's ideas.", answer: "Prophylaxis", reward: 10 },
    { id: 265, type: "chess", question: "Name the motif: interference to block lines.", answer: "Interference", reward: 10 },
    { id: 266, type: "chess", question: "Name the motif: clearance sacrifice.", answer: "Clearance sacrifice", reward: 15 },
    { id: 267, type: "chess", question: "Name the motif: attraction decoy.", answer: "Decoy", reward: 10 },
    { id: 268, type: "chess", question: "Name the motif: double attack with queen.", answer: "Double attack", reward: 10 },
    { id: 269, type: "chess", question: "Name the motif: skewer against king and rook.", answer: "Skewer", reward: 10 },
    { id: 270, type: "chess", question: "Name the motif: pin against queen.", answer: "Relative pin", reward: 10 },
    { id: 271, type: "chess", question: "Name the motif: absolute pin against king.", answer: "Absolute pin", reward: 10 },
    { id: 272, type: "chess", question: "Name the motif: underpromotion to knight to avoid stalemate.", answer: "Underpromotion", reward: 15 },
    { id: 273, type: "chess", question: "Name the motif: square of the pawn in king and pawn endings.", answer: "Square of the pawn", reward: 15 },
    { id: 274, type: "chess", question: "Name the motif: building bridge in rook endings.", answer: "Lucena", reward: 15 },
    { id: 275, type: "chess", question: "Name the motif: defensive technique against rook + pawn.", answer: "Philidor", reward: 15 },
    { id: 276, type: "chess", question: "Name the motif: opposition in pawn endings.", answer: "Opposition", reward: 15 },
    { id: 277, type: "chess", question: "Name the motif: queen sacrifice to force mate.", answer: "Queen sac mate", reward: 15 },
    { id: 278, type: "chess", question: "Name the motif: bishop and knight mate technique.", answer: "Bishop and knight mate", reward: 15 },
    { id: 279, type: "chess", question: "Name the motif: rook roller ladder mate.", answer: "Rook roller", reward: 10 },
    { id: 280, type: "chess", question: "Name the motif: smothered mate pattern with knight.", answer: "Smothered mate", reward: 15 },
    { id: 281, type: "chess", question: "Name the motif: mate net with Qh7+ or Qh2+", answer: "Greek gift ideas", reward: 15 },
    { id: 282, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 c5.", answer: "Benoni/Benko ideas", aliases: ["benko"], reward: 15 },
    { id: 283, type: "chess", question: "Name the opening: 1. d4 Nf6 2. c4 c5 3. d5 b5.", answer: "Benko Gambit", aliases: ["benko"], reward: 15 },
    { id: 284, type: "chess", question: "Name the opening: 1. d4 f5 2. c4 Nf6 3. g3.", answer: "Dutch, Leningrad", aliases: ["leningrad"], reward: 15 },
    { id: 285, type: "chess", question: "Name the opening: 1. d4 d5 2. Bf4.", answer: "London System", reward: 15 },
    { id: 286, type: "chess", question: "Name the opening: 1. d4 d5 2. c4 e6 3. Nc3 Be7.", answer: "QGD Orthodox", aliases: ["orthodox"], reward: 15 },
    { id: 287, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Nf6.", answer: "Berlin Defense", aliases: ["berlin"], reward: 15 },
    { id: 288, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 d6.", answer: "Steinitz Defense (Ruy)", reward: 15 },
    { id: 289, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 g6.", answer: "Ruy Lopez, Smyslov Defense", aliases: ["smyslov"], reward: 15 },
    { id: 290, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Bc5.", answer: "Ruy Lopez, Classical", aliases: ["classical"], reward: 15 },
    { id: 291, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6.", answer: "Ruy Lopez, Closed", aliases: ["closed ruy"], reward: 15 },
    { id: 292, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5.", answer: "Ruy Lopez, Arkhangelsk", aliases: ["arkhangelsk"], reward: 15 },
    { id: 293, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 Nd4.", answer: "Ruy Lopez, Bird Defense", aliases: ["bird defense"], reward: 15 },
    { id: 294, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bb5 f5.", answer: "Ruy Lopez, Schliemann Defense", aliases: ["schliemann"], reward: 15 },
    { id: 295, type: "chess", question: "Name the opening: 1. e4 c5 2. c3.", answer: "Sicilian Alapin", reward: 15 },
    { id: 296, type: "chess", question: "Name the opening: 1. e4 c5 2. Nc3.", answer: "Sicilian Closed", aliases: ["closed sicilian"], reward: 15 },
    { id: 297, type: "chess", question: "Name the opening: 1. e4 c5 2. d4 cxd4 3. c3.", answer: "Sicilian Smith-Morra", aliases: ["smith morra"], reward: 15 },
    { id: 298, type: "chess", question: "Name the opening: 1. e4 Nf6 2. e5 Nd5.", answer: "Alekhine Defense, Modern", reward: 15 },
    { id: 299, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5.", answer: "Italian Game, Giuoco Piano", aliases: ["giuoco piano"], reward: 15 },
    { id: 300, type: "chess", question: "Name the opening: 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6.", answer: "Italian, Two Knights Defense", aliases: ["two knights"], reward: 15 },
    // Football (301-600)
    { id: 301, type: "football", question: "Who has won the most Ballon d'Or awards?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
    { id: 302, type: "football", question: "Which country has won the most World Cups?", answer: "Brazil", reward: 10 },
    { id: 303, type: "football", question: "Who is the all-time leading goalscorer in international football?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 10 },
    { id: 304, type: "football", question: "Which club has won the most UEFA Champions League titles?", answer: "Real Madrid", reward: 10 },
    { id: 305, type: "football", question: "Who won the 2022 FIFA World Cup?", answer: "Argentina", reward: 10 },
    { id: 306, type: "football", question: "Which player is known as 'O Rei' (The King)?", answer: "Pele", reward: 10 },
    { id: 307, type: "football", question: "Who scored the 'Hand of God' goal?", answer: "Diego Maradona", aliases: ["maradona"], reward: 10 },
    { id: 308, type: "football", question: "Which stadium is known as 'The Theatre of Dreams'?", answer: "Old Trafford", reward: 10 },
    { id: 309, type: "football", question: "Who is the all-time leading scorer for the England national team?", answer: "Harry Kane", reward: 10 },
    { id: 310, type: "football", question: "Which country hosted the first ever World Cup in 1930?", answer: "Uruguay", reward: 10 },
    { id: 311, type: "football", question: "Who won the Premier League in the 2015-16 season in a historic underdog story?", answer: "Leicester City", aliases: ["leicester"], reward: 15 },
    { id: 312, type: "football", question: "Who is the youngest player to score in a World Cup final?", answer: "Pele", reward: 15 },
    { id: 313, type: "football", question: "Which player won the Ballon d'Or in 2005?", answer: "Ronaldinho", reward: 10 },
    { id: 314, type: "football", question: "What is the maximum number of players allowed on the pitch for one team in a professional match?", answer: "11", reward: 5 },
    { id: 315, type: "football", question: "Who is the manager of Manchester City (as of 2024)?", answer: "Pep Guardiola", aliases: ["guardiola"], reward: 10 },
    { id: 316, type: "football", question: "Which country won the Euro 2020 (played in 2021)?", answer: "Italy", reward: 10 },
    { id: 317, type: "football", question: "Who is the all-time leading scorer in the UEFA Champions League?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 10 },
    { id: 318, type: "football", question: "Which club does Erling Haaland play for (as of 2024)?", answer: "Manchester City", aliases: ["man city"], reward: 10 },
    { id: 319, type: "football", question: "Who won the 2023 Women's World Cup?", answer: "Spain", reward: 10 },
    { id: 320, type: "football", question: "Which player is known for the 'Siuuu' celebration?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 5 },
    { id: 321, type: "football", question: "Who is the all-time leading scorer for FC Barcelona?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
    { id: 322, type: "football", question: "Which country won the 2014 World Cup?", answer: "Germany", reward: 10 },
    { id: 323, type: "football", question: "Who is known as 'The Special One'?", answer: "Jose Mourinho", aliases: ["mourinho"], reward: 10 },
    { id: 324, type: "football", question: "Which team plays their home matches at Anfield?", answer: "Liverpool", reward: 10 },
    { id: 325, type: "football", question: "Who won the Ballon d'Or in 2023?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
    { id: 326, type: "football", question: "Which player holds the record for most goals in a single calendar year?", answer: "Lionel Messi", aliases: ["messi"], reward: 15 },
    { id: 327, type: "football", question: "What is the distance of a penalty kick from the goal line (in yards)?", answer: "12", reward: 5 },
    { id: 328, type: "football", question: "Who won the first ever Premier League title?", answer: "Manchester United", reward: 10 },
    { id: 329, type: "football", question: "Which player is nicknamed 'The Egyptian King'?", answer: "Mohamed Salah", aliases: ["salah"], reward: 10 },
    { id: 330, type: "football", question: "Who won the 2010 World Cup?", answer: "Spain", reward: 10 },
    { id: 331, type: "football", question: "Which club is known as 'The Gunners'?", answer: "Arsenal", reward: 10 },
    { id: 332, type: "football", question: "Who is the most expensive football player in history (transfer fee)?", answer: "Neymar", aliases: ["neymar jr"], reward: 15 },
    { id: 333, type: "football", question: "Which country won the 1998 World Cup?", answer: "France", reward: 10 },
    { id: 334, type: "football", question: "Who is the all-time top scorer in World Cup history?", answer: "Miroslav Klose", aliases: ["klose"], reward: 15 },
    { id: 335, type: "football", question: "Which team is known as 'The Red Devils'?", answer: "Manchester United", reward: 10 },
    { id: 336, type: "football", question: "Who won the Ballon d'Or in 2018, breaking the Messi-Ronaldo streak?", answer: "Luka Modric", aliases: ["modric"], reward: 10 },
    { id: 337, type: "football", question: "Which stadium is the home of the England national team?", answer: "Wembley", reward: 10 },
    { id: 338, type: "football", question: "Who is the current captain of the France national team (as of 2024)?", answer: "Kylian Mbappe", aliases: ["mbappe"], reward: 10 },
    { id: 339, type: "football", question: "Which club won the 'Treble' (PL, FA Cup, CL) in 1999?", answer: "Manchester United", reward: 15 },
    { id: 340, type: "football", question: "Which player is known for his incredible free-kicks and 'Bend it like' style?", answer: "David Beckham", aliases: ["beckham"], reward: 10 },
    { id: 341, type: "football", question: "Who won the 2006 World Cup?", answer: "Italy", reward: 10 },
    { id: 342, type: "football", question: "Which club is known as 'The Blues'?", answer: "Chelsea", reward: 5 },
    { id: 343, type: "football", question: "Who is the all-time leading scorer for Real Madrid?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 10 },
    { id: 344, type: "football", question: "Which country won the first ever European Championship in 1960?", answer: "Soviet Union", aliases: ["ussr"], reward: 15 },
    { id: 345, type: "football", question: "Who is the manager of Liverpool (as of late 2024)?", answer: "Arne Slot", reward: 15 },
    { id: 346, type: "football", question: "Which player is nicknamed 'Zizou'?", answer: "Zinedine Zidane", aliases: ["zidane"], reward: 10 },
    { id: 347, type: "football", question: "Which club plays at the Santiago Bernabeu?", answer: "Real Madrid", reward: 5 },
    { id: 348, type: "football", question: "Who won the 1966 World Cup?", answer: "England", reward: 10 },
    { id: 349, type: "football", question: "Which player won the Ballon d'Or in 2022?", answer: "Karim Benzema", aliases: ["benzema"], reward: 10 },
    { id: 350, type: "football", question: "Who is the all-time leading scorer for Brazil?", answer: "Neymar", aliases: ["neymar jr"], reward: 15 },
     { id: 351, type: "football", question: "Which club did Cristiano Ronaldo join in 2023?", answer: "Al-Nassr", reward: 10 },
     { id: 352, type: "football", question: "Who won the Golden Boot in the 2022 World Cup?", answer: "Kylian Mbappe", aliases: ["mbappe"], reward: 10 },
     { id: 353, type: "football", question: "Which team is known as 'La Albiceleste'?", answer: "Argentina", reward: 5 },
     { id: 354, type: "football", question: "Who is the all-time top scorer for the German national team?", answer: "Miroslav Klose", aliases: ["klose"], reward: 10 },
     { id: 355, type: "football", question: "Which player is known as 'The Atomic Flea'?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
     { id: 356, type: "football", question: "Who won the Champions League in 2023?", answer: "Manchester City", aliases: ["man city"], reward: 10 },
     { id: 357, type: "football", question: "Which club does Robert Lewandowski play for (as of 2024)?", answer: "FC Barcelona", aliases: ["barcelona"], reward: 10 },
     { id: 358, type: "football", question: "Who is the all-time leading scorer in the Premier League?", answer: "Alan Shearer", reward: 15 },
     { id: 359, type: "football", question: "Which country won the 1970 World Cup?", answer: "Brazil", reward: 10 },
     { id: 360, type: "football", question: "Who is the manager of Real Madrid (as of 2024)?", answer: "Carlo Ancelotti", aliases: ["ancelotti"], reward: 10 },
     { id: 361, type: "football", question: "Which player is nicknamed 'El Pistolero'?", answer: "Luis Suarez", aliases: ["suarez"], reward: 10 },
     { id: 362, type: "football", question: "Which team plays at the Allianz Arena?", answer: "Bayern Munich", reward: 10 },
     { id: 363, type: "football", question: "Who won the first ever Ballon d'Or in 1956?", answer: "Stanley Matthews", reward: 15 },
     { id: 364, type: "football", question: "Which country won the 2018 World Cup?", answer: "France", reward: 10 },
     { id: 365, type: "football", question: "Who is the all-time leading scorer for Italy?", answer: "Luigi Riva", reward: 15 },
     { id: 366, type: "football", question: "Which club is known as 'The Old Lady'?", answer: "Juventus", reward: 10 },
     { id: 367, type: "football", question: "Who won the Ballon d'Or in 2007, the last before Messi/Ronaldo era?", answer: "Kaka", reward: 10 },
     { id: 368, type: "football", question: "Which stadium is the home of FC Barcelona?", answer: "Camp Nou", reward: 5 },
     { id: 369, type: "football", question: "Who is the current captain of the Brazil national team (as of 2024)?", answer: "Danilo", reward: 15 },
     { id: 370, type: "football", question: "Which player is known for the 'Hand of God' and 'Goal of the Century'?", answer: "Diego Maradona", aliases: ["maradona"], reward: 10 },
     { id: 371, type: "football", question: "Who won the 1974 World Cup?", answer: "West Germany", reward: 10 },
     { id: 372, type: "football", question: "Which club did Zlatan Ibrahimovic play for last before retiring?", answer: "AC Milan", reward: 10 },
     { id: 373, type: "football", question: "Who is the all-time top scorer for France?", answer: "Olivier Giroud", reward: 15 },
     { id: 374, type: "football", question: "Which team is known as 'Die Mannschaft'?", answer: "Germany", reward: 5 },
     { id: 375, type: "football", question: "Who won the Champions League in 2022?", answer: "Real Madrid", reward: 10 },
     { id: 376, type: "football", question: "Which player is nicknamed 'The Phenomenon' (O Fenômeno)?", answer: "Ronaldo Nazario", aliases: ["ronaldo"], reward: 10 },
     { id: 377, type: "football", question: "Which country won the 1982 World Cup?", answer: "Italy", reward: 10 },
     { id: 378, type: "football", question: "Who is the manager of Arsenal (as of 2024)?", answer: "Mikel Arteta", aliases: ["arteta"], reward: 10 },
     { id: 379, type: "football", question: "Which club is known as 'The Citizens'?", answer: "Manchester City", reward: 5 },
     { id: 380, type: "football", question: "Who won the Ballon d'Or in 2004?", answer: "Andriy Shevchenko", reward: 15 },
     { id: 381, type: "football", question: "Which stadium is the home of Real Madrid?", answer: "Santiago Bernabeu", reward: 5 },
     { id: 382, type: "football", question: "Who is the all-time leading scorer for Portugal?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 10 },
     { id: 383, type: "football", question: "Which country won the 2002 World Cup?", answer: "Brazil", reward: 10 },
     { id: 384, type: "football", question: "Who is the current captain of Argentina (as of 2024)?", answer: "Lionel Messi", aliases: ["messi"], reward: 5 },
     { id: 385, type: "football", question: "Which player is known for his 'Rabona' kicks?", answer: "Ricardo Quaresma", reward: 15 },
     { id: 386, type: "football", question: "Which club did David Beckham play for in the USA?", answer: "LA Galaxy", reward: 10 },
     { id: 387, type: "football", question: "Who won the 1994 World Cup?", answer: "Brazil", reward: 10 },
     { id: 388, type: "football", question: "Which player is nicknamed 'The Flea'?", answer: "Lionel Messi", aliases: ["messi"], reward: 5 },
     { id: 389, type: "football", question: "Who is the all-time top scorer for the Netherlands?", answer: "Robin van Persie", reward: 15 },
     { id: 390, type: "football", question: "Which team is known as 'The Oranje'?", answer: "Netherlands", aliases: ["holland"], reward: 5 },
     { id: 391, type: "football", question: "Who won the Champions League in 2021?", answer: "Chelsea", reward: 10 },
     { id: 392, type: "football", question: "Which player is known as 'CR7'?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 5 },
     { id: 393, type: "football", question: "Which country won the 1978 World Cup?", answer: "Argentina", reward: 10 },
     { id: 394, type: "football", question: "Who is the manager of the England national team (as of late 2024)?", answer: "Thomas Tuchel", reward: 15 },
     { id: 395, type: "football", question: "Which club is known as 'The Red Devils'?", answer: "Manchester United", reward: 5 },
     { id: 396, type: "football", question: "Who won the Ballon d'Or in 2003?", answer: "Pavel Nedved", reward: 15 },
     { id: 397, type: "football", question: "Which stadium is known as 'San Siro'?", answer: "Giuseppe Meazza", reward: 10 },
     { id: 398, type: "football", question: "Who is the all-time leading scorer for Spain?", answer: "David Villa", reward: 15 },
     { id: 399, type: "football", question: "Which country won the 1986 World Cup?", answer: "Argentina", reward: 10 },
    { id: 400, type: "football", question: "Who won the 2024 Euro?", answer: "Spain", reward: 10 },
    { id: 401, type: "football", question: "Which player won the 2023 Ballon d'Or?", answer: "Lionel Messi", reward: 10 },
    { id: 401, type: "football", question: "Who is the manager of Bayer Leverkusen (as of 2024)?", answer: "Xabi Alonso", aliases: ["alonso"], reward: 15 },
    { id: 402, type: "football", question: "Which club won the Bundesliga in 2023-24 without losing a game?", answer: "Bayer Leverkusen", aliases: ["leverkusen"], reward: 15 },
    { id: 403, type: "football", question: "Who is the all-time leading scorer in the Bundesliga?", answer: "Gerd Muller", reward: 15 },
    { id: 404, type: "football", question: "Which player is known as 'The King' in French football?", answer: "Thierry Henry", reward: 10 },
    { id: 405, type: "football", question: "Who won the Ballon d'Or in 2009?", answer: "Lionel Messi", reward: 10 },
    { id: 406, type: "football", question: "Which club did Jude Bellingham join in 2023?", answer: "Real Madrid", reward: 10 },
    { id: 407, type: "football", question: "Who is the all-time leading scorer for Belgium?", answer: "Romelu Lukaku", reward: 15 },
    { id: 408, type: "football", question: "Which country hosted the 2006 World Cup?", answer: "Germany", reward: 10 },
    { id: 409, type: "football", question: "Who won the Golden Ball in the 2022 World Cup?", answer: "Lionel Messi", reward: 10 },
    { id: 410, type: "football", question: "Which player is known for the 'Cruyff Turn'?", answer: "Johan Cruyff", reward: 10 },
    { id: 411, type: "football", question: "Which club is known as 'The Toffees'?", answer: "Everton", reward: 10 },
    { id: 412, type: "football", question: "Who is the all-time leading scorer for Manchester City?", answer: "Sergio Aguero", reward: 15 },
    { id: 413, type: "football", question: "Which country won the Euro 2016?", answer: "Portugal", reward: 10 },
    { id: 414, type: "football", question: "Who is the manager of the France national team (as of 2024)?", answer: "Didier Deschamps", reward: 10 },
    { id: 415, type: "football", question: "Which player is nicknamed 'The Shark' (Ferran Torres)?", answer: "Ferran Torres", reward: 15 },
    { id: 416, type: "football", question: "Which team plays at the Emirates Stadium?", answer: "Arsenal", reward: 5 },
    { id: 417, type: "football", question: "Who won the first ever World Cup in 1930?", answer: "Uruguay", reward: 10 },
    { id: 418, type: "football", question: "Who is the all-time leading scorer for Chelsea?", answer: "Frank Lampard", reward: 15 },
    { id: 419, type: "football", question: "Which player is known as 'The Non-Flying Dutchman'?", answer: "Dennis Bergkamp", reward: 15 },
    { id: 420, type: "football", question: "Which club did Erling Haaland play for before Man City?", answer: "Borussia Dortmund", aliases: ["dortmund"], reward: 10 },
    { id: 421, type: "football", question: "Who won the Ballon d'Or in 2010?", answer: "Lionel Messi", reward: 10 },
    { id: 422, type: "football", question: "Which country won the 1958 World Cup?", answer: "Brazil", reward: 10 },
    { id: 423, type: "football", question: "Who is the current manager of Tottenham (as of 2024)?", answer: "Ange Postecoglou", reward: 15 },
    { id: 424, type: "football", question: "Which player is known for his overhead kick against Juventus in 2018?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 425, type: "football", question: "Which club is known as 'The Magpies'?", answer: "Newcastle United", reward: 10 },
    { id: 426, type: "football", question: "Who is the all-time leading scorer for Poland?", answer: "Robert Lewandowski", reward: 10 },
    { id: 427, type: "football", question: "Which country won the Euro 2008?", answer: "Spain", reward: 10 },
    { id: 428, type: "football", question: "Who is the manager of Atletico Madrid (as of 2024)?", answer: "Diego Simeone", reward: 10 },
    { id: 429, type: "football", question: "Which player is nicknamed 'Kun'?", answer: "Sergio Aguero", reward: 10 },
    { id: 430, type: "football", question: "Which team plays at the Etihad Stadium?", answer: "Manchester City", reward: 5 },
    { id: 431, type: "football", question: "Who won the Ballon d'Or in 2011?", answer: "Lionel Messi", reward: 10 },
    { id: 432, type: "football", question: "Which country won the 1962 World Cup?", answer: "Brazil", reward: 10 },
    { id: 433, type: "football", question: "Who is the all-time leading scorer for Uruguay?", answer: "Luis Suarez", reward: 15 },
    { id: 434, type: "football", question: "Which player is known for his 'Scorpion Kick' goal for Arsenal?", answer: "Olivier Giroud", reward: 15 },
    { id: 435, type: "football", question: "Which club is known as 'The Hammers'?", answer: "West Ham United", reward: 10 },
    { id: 436, type: "football", question: "Who is the current captain of England (as of 2024)?", answer: "Harry Kane", reward: 5 },
    { id: 437, type: "football", question: "Which country won the 1990 World Cup?", answer: "West Germany", reward: 10 },
    { id: 438, type: "football", question: "Who won the Ballon d'Or in 2012?", answer: "Lionel Messi", reward: 10 },
    { id: 439, type: "football", question: "Which player is known as 'The Architect'?", answer: "Andrea Pirlo", reward: 10 },
    { id: 440, type: "football", question: "Which club did Lionel Messi join in 2023?", answer: "Inter Miami", reward: 10 },
    { id: 441, type: "football", question: "Who is the all-time leading scorer for Liverpool?", answer: "Ian Rush", reward: 15 },
    { id: 442, type: "football", question: "Which country won the Euro 2012?", answer: "Spain", reward: 10 },
    { id: 443, type: "football", question: "Who is the manager of the Netherlands national team (as of 2024)?", answer: "Ronald Koeman", reward: 15 },
    { id: 444, type: "football", question: "Which player is nicknamed 'The Octopus' (Buffon)?", answer: "Gianluigi Buffon", reward: 15 },
    { id: 445, type: "football", question: "Which team plays at Stamford Bridge?", answer: "Chelsea", reward: 5 },
    { id: 446, type: "football", question: "Who won the Ballon d'Or in 2013?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 447, type: "football", question: "Which country won the 1934 World Cup?", answer: "Italy", reward: 10 },
    { id: 448, type: "football", question: "Who is the all-time leading scorer for Arsenal?", answer: "Thierry Henry", reward: 10 },
    { id: 449, type: "football", question: "Which player is known for his 'Panenka' penalty in the 2006 World Cup final?", answer: "Zinedine Zidane", reward: 15 },
    { id: 450, type: "football", question: "Which club is known as 'The Villans'?", answer: "Aston Villa", reward: 10 },
    { id: 451, type: "football", question: "Who won the Golden Glove in the 2022 World Cup?", answer: "Emiliano Martinez", aliases: ["dibu"], reward: 10 },
    { id: 452, type: "football", question: "Which country won the 1938 World Cup?", answer: "Italy", reward: 10 },
    { id: 453, type: "football", question: "Who won the Ballon d'Or in 2014?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 454, type: "football", question: "Which player is nicknamed 'El Chiringuito'?", answer: "Not a player", reward: 0 },
    { id: 455, type: "football", question: "Who is the all-time leading scorer for AC Milan?", answer: "Gunnar Nordahl", reward: 20 },
    { id: 456, type: "football", question: "Which country won the Euro 2004 in a major upset?", answer: "Greece", reward: 15 },
    { id: 457, type: "football", question: "Who is the manager of the Italy national team (as of 2024)?", answer: "Luciano Spalletti", reward: 15 },
    { id: 458, type: "football", question: "Which player is known for his 'Step-over' skill?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 5 },
    { id: 459, type: "football", question: "Which team plays at the Signal Iduna Park?", answer: "Borussia Dortmund", reward: 10 },
    { id: 460, type: "football", question: "Who won the Ballon d'Or in 2015?", answer: "Lionel Messi", reward: 10 },
    { id: 461, type: "football", question: "Which country won the 1950 World Cup (The Maracanazo)?", answer: "Uruguay", reward: 15 },
    { id: 462, type: "football", question: "Who is the all-time leading scorer for Juventus?", answer: "Alessandro Del Piero", reward: 15 },
    { id: 463, type: "football", question: "Which player is known as 'The Divine Ponytail'?", answer: "Roberto Baggio", reward: 15 },
    { id: 464, type: "football", question: "Which club did Neymar join from Barcelona?", answer: "PSG", aliases: ["paris saint germain"], reward: 10 },
    { id: 465, type: "football", question: "Who won the Ballon d'Or in 2016?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 466, type: "football", question: "Which country won the 1954 World Cup (Miracle of Bern)?", answer: "West Germany", reward: 15 },
    { id: 467, type: "football", question: "Who is the current manager of Manchester United (as of late 2024)?", answer: "Ruben Amorim", reward: 15 },
    { id: 468, type: "football", question: "Which player is known for his 'Thunderbolt' free-kicks for Inter Milan?", answer: "Adriano", reward: 15 },
    { id: 469, type: "football", question: "Which club is known as 'The Eagles' (Benfica)?", answer: "Benfica", reward: 10 },
    { id: 470, type: "football", question: "Who is the all-time leading scorer for Chile?", answer: "Alexis Sanchez", reward: 15 },
    { id: 471, type: "football", question: "Which country won the Euro 2000?", answer: "France", reward: 10 },
    { id: 472, type: "football", question: "Who is the manager of the Portugal national team (as of 2024)?", answer: "Roberto Martinez", reward: 15 },
    { id: 473, type: "football", question: "Which player is nicknamed 'The Baby-Faced Assassin'?", answer: "Ole Gunnar Solskjaer", reward: 15 },
    { id: 474, type: "football", question: "Which team plays at the Wanda Metropolitano?", answer: "Atletico Madrid", reward: 10 },
    { id: 475, type: "football", question: "Who won the Ballon d'Or in 2017?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 476, type: "football", question: "Which country won the 1966 World Cup?", answer: "England", reward: 5 },
    { id: 477, type: "football", question: "Who is the all-time leading scorer for Manchester United?", answer: "Wayne Rooney", reward: 10 },
    { id: 478, type: "football", question: "Which player is known for his 'No-look' passes?", answer: "Ronaldinho", reward: 10 },
    { id: 479, type: "football", question: "Which club is known as 'The Spurs'?", answer: "Tottenham Hotspur", reward: 5 },
    { id: 480, type: "football", question: "Who won the Golden Boot in the 2018 World Cup?", answer: "Harry Kane", reward: 10 },
    { id: 481, type: "football", question: "Which country won the 1974 World Cup?", answer: "West Germany", reward: 10 },
    { id: 482, type: "football", question: "Who is the all-time leading scorer for Spain?", answer: "David Villa", reward: 10 },
    { id: 483, type: "football", question: "Which player is known as 'The Wall' (Oliver Kahn)?", answer: "Oliver Kahn", reward: 15 },
    { id: 484, type: "football", question: "Which club did Luis Suarez play for before Atletico Madrid?", answer: "FC Barcelona", reward: 5 },
    { id: 485, type: "football", question: "Who won the Ballon d'Or in 2019?", answer: "Lionel Messi", reward: 10 },
    { id: 486, type: "football", question: "Which country won the 1982 World Cup?", answer: "Italy", reward: 10 },
    { id: 487, type: "football", question: "Who is the all-time leading scorer for France?", answer: "Olivier Giroud", reward: 10 },
    { id: 488, type: "football", question: "Which player is known as 'The Little Mozart'?", answer: "Tomas Rosicky", reward: 20 },
    { id: 489, type: "football", question: "Which club is known as 'The Bees'?", answer: "Brentford", reward: 10 },
    { id: 490, type: "football", question: "Who won the Golden Boot in the 2014 World Cup?", answer: "James Rodriguez", reward: 15 },
    { id: 491, type: "football", question: "Which country won the 1990 World Cup?", answer: "West Germany", reward: 10 },
    { id: 492, type: "football", question: "Who is the all-time leading scorer for Argentina?", answer: "Lionel Messi", reward: 5 },
    { id: 493, type: "football", question: "Which player is known as 'The White Pele'?", answer: "Zico", reward: 15 },
    { id: 494, type: "football", question: "Which club is known as 'The Cherries'?", answer: "Bournemouth", reward: 10 },
    { id: 495, type: "football", question: "Who won the Golden Boot in the 2010 World Cup?", answer: "Thomas Muller", reward: 15 },
    { id: 496, type: "football", question: "Which country won the 1994 World Cup?", answer: "Brazil", reward: 10 },
    { id: 497, type: "football", question: "Who is the all-time leading scorer for Italy?", answer: "Luigi Riva", reward: 15 },
    { id: 498, type: "football", question: "Which player is known as 'The Black Spider'?", answer: "Lev Yashin", reward: 15 },
    { id: 499, type: "football", question: "Which club is known as 'The Cottagers'?", answer: "Fulham", reward: 10 },
    { id: 500, type: "football", question: "Who won the Golden Boot in the 2006 World Cup?", answer: "Miroslav Klose", reward: 15 },
    { id: 501, type: "football", question: "Which country won the 1998 World Cup?", answer: "France", reward: 10 },
    { id: 502, type: "football", question: "Who is the all-time leading scorer for Germany?", answer: "Miroslav Klose", reward: 10 },
    { id: 503, type: "football", question: "Which player is known as 'The Emperor'?", answer: "Franz Beckenbauer", reward: 15 },
    { id: 504, type: "football", question: "Which club is known as 'The Saints'?", answer: "Southampton", reward: 10 },
    { id: 505, type: "football", question: "Who won the Golden Boot in the 2002 World Cup?", answer: "Ronaldo", reward: 10 },
    { id: 506, type: "football", question: "Which country won the 2002 World Cup?", answer: "Brazil", reward: 5 },
    { id: 507, type: "football", question: "Who is the all-time leading scorer for England?", answer: "Harry Kane", reward: 10 },
    { id: 508, type: "football", question: "Which player is known as 'The Non-Flying Dutchman'?", answer: "Dennis Bergkamp", reward: 15 },
    { id: 509, type: "football", question: "Which club is known as 'The Foxes'?", answer: "Leicester City", reward: 5 },
    { id: 510, type: "football", question: "Who won the Golden Boot in the 1998 World Cup?", answer: "Davor Suker", reward: 15 },
    { id: 511, type: "football", question: "Which country won the 2006 World Cup?", answer: "Italy", reward: 10 },
    { id: 512, type: "football", question: "Who is the all-time leading scorer for Brazil?", answer: "Neymar", reward: 10 },
    { id: 513, type: "football", question: "Which player is known as 'The Golden Boy'?", answer: "Gianni Rivera", reward: 20 },
    { id: 514, type: "football", question: "Which club is known as 'The Canaries'?", answer: "Norwich City", reward: 10 },
    { id: 515, type: "football", question: "Who won the Golden Boot in the 1994 World Cup?", answer: "Oleg Salenko and Hristo Stoichkov", reward: 15 },
    { id: 516, type: "football", question: "Which country won the 2010 World Cup?", answer: "Spain", reward: 10 },
    { id: 517, type: "football", question: "Who is the all-time leading scorer for Portugal?", answer: "Cristiano Ronaldo", reward: 5 },
    { id: 518, type: "football", question: "Which player is known as 'The Pitbull'?", answer: "Edgar Davids", reward: 15 },
    { id: 519, type: "football", question: "Which club is known as 'The Potters'?", answer: "Stoke City", reward: 10 },
    { id: 520, type: "football", question: "Who won the Golden Boot in the 1990 World Cup?", answer: "Salvatore Schillaci", reward: 15 },
    { id: 521, type: "football", question: "Which country won the 2014 World Cup?", answer: "Germany", reward: 10 },
    { id: 522, type: "football", question: "Who is the all-time leading scorer for the Netherlands?", answer: "Robin van Persie", reward: 10 },
    { id: 523, type: "football", question: "Which player is known as 'The Bulldog'?", answer: "Carlos Tevez", reward: 15 },
    { id: 524, type: "football", question: "Which club is known as 'The Black Cats'?", answer: "Sunderland", reward: 10 },
    { id: 525, type: "football", question: "Who won the Golden Boot in the 1986 World Cup?", answer: "Gary Lineker", reward: 15 },
    { id: 526, type: "football", question: "Which country won the 2018 World Cup?", answer: "France", reward: 10 },
    { id: 527, type: "football", question: "Who is the all-time leading scorer for France?", answer: "Olivier Giroud", reward: 10 },
    { id: 528, type: "football", question: "Which player is known as 'The Magician'?", answer: "Ronaldinho", reward: 10 },
    { id: 529, type: "football", question: "Which club is known as 'The Toffees'?", answer: "Everton", reward: 10 },
    { id: 530, type: "football", question: "Who won the Golden Boot in the 1982 World Cup?", answer: "Paolo Rossi", reward: 15 },
    { id: 531, type: "football", question: "Which country won the 2022 World Cup?", answer: "Argentina", reward: 10 },
    { id: 532, type: "football", question: "Who is the all-time leading scorer for Belgium?", answer: "Romelu Lukaku", reward: 10 },
    { id: 533, type: "football", question: "Which player is known as 'The Lion King'?", answer: "Gabriel Batistuta", reward: 15 },
    { id: 534, type: "football", question: "Which club is known as 'The Swans'?", answer: "Swansea City", reward: 10 },
    { id: 535, type: "football", question: "Who won the Golden Boot in the 1978 World Cup?", answer: "Mario Kempes", reward: 15 },
    { id: 536, type: "football", question: "Who is the all-time leading scorer in the Champions League?", answer: "Cristiano Ronaldo", reward: 5 },
    { id: 537, type: "football", question: "Which player has the most assists in Premier League history?", answer: "Ryan Giggs", reward: 15 },
    { id: 538, type: "football", question: "Which player is known as 'The Non-Flying Dutchman'?", answer: "Dennis Bergkamp", reward: 15 },
    { id: 539, type: "football", question: "Which club did Cristiano Ronaldo join after Real Madrid?", answer: "Juventus", reward: 10 },
    { id: 540, type: "football", question: "Who won the Ballon d'Or in 2021?", answer: "Lionel Messi", reward: 10 },
    { id: 541, type: "football", question: "Which player scored the fastest goal in Premier League history?", answer: "Shane Long", reward: 15 },
    { id: 542, type: "football", question: "Which country won the Euro 2004?", answer: "Greece", reward: 15 },
    { id: 543, type: "football", question: "Who is the manager of Liverpool (as of late 2024)?", answer: "Arne Slot", reward: 15 },
    { id: 544, type: "football", question: "Which player is known as 'The Octopus' (Buffon)?", answer: "Gianluigi Buffon", reward: 15 },
    { id: 545, type: "football", question: "Which team plays at Stamford Bridge?", answer: "Chelsea", reward: 5 },
    { id: 546, type: "football", question: "Who won the Ballon d'Or in 2013?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 547, type: "football", question: "Which country won the 1934 World Cup?", answer: "Italy", reward: 10 },
    { id: 548, type: "football", question: "Who is the all-time leading scorer for Arsenal?", answer: "Thierry Henry", reward: 10 },
    { id: 549, type: "football", question: "Which player is known for his 'Panenka' penalty in the 2006 World Cup final?", answer: "Zinedine Zidane", reward: 15 },
    { id: 550, type: "football", question: "Which club is known as 'The Villans'?", answer: "Aston Villa", reward: 10 },
    { id: 551, type: "football", question: "Who won the Golden Glove in the 2022 World Cup?", answer: "Emiliano Martinez", reward: 10 },
    { id: 552, type: "football", question: "Which country won the 1938 World Cup?", answer: "Italy", reward: 10 },
    { id: 553, type: "football", question: "Who won the Ballon d'Or in 2014?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 554, type: "football", question: "Who is the all-time leading scorer for AC Milan?", answer: "Gunnar Nordahl", reward: 20 },
    { id: 555, type: "football", question: "Which country won the Euro 2004 in a major upset?", answer: "Greece", reward: 15 },
    { id: 556, type: "football", question: "Who is the manager of the Italy national team (as of 2024)?", answer: "Luciano Spalletti", reward: 15 },
    { id: 557, type: "football", question: "Which player is known for his 'Step-over' skill?", answer: "Cristiano Ronaldo", reward: 5 },
    { id: 558, type: "football", question: "Which team plays at the Signal Iduna Park?", answer: "Borussia Dortmund", reward: 10 },
    { id: 559, type: "football", question: "Who won the Ballon d'Or in 2015?", answer: "Lionel Messi", reward: 10 },
    { id: 560, type: "football", question: "Which country won the 1950 World Cup?", answer: "Uruguay", reward: 15 },
    { id: 561, type: "football", question: "Who is the all-time leading scorer for Juventus?", answer: "Alessandro Del Piero", reward: 15 },
    { id: 562, type: "football", question: "Which player is known as 'The Divine Ponytail'?", answer: "Roberto Baggio", reward: 15 },
    { id: 563, type: "football", question: "Which club did Neymar join from Barcelona?", answer: "PSG", reward: 10 },
    { id: 564, type: "football", question: "Who won the Ballon d'Or in 2016?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 565, type: "football", question: "Which country won the 1954 World Cup?", answer: "West Germany", reward: 15 },
    { id: 566, type: "football", question: "Who is the current manager of Manchester United (as of late 2024)?", answer: "Ruben Amorim", reward: 15 },
    { id: 567, type: "football", question: "Which player is known for his 'Thunderbolt' free-kicks for Inter Milan?", answer: "Adriano", reward: 15 },
    { id: 568, type: "football", question: "Which club is known as 'The Eagles'?", answer: "Benfica", reward: 10 },
    { id: 569, type: "football", question: "Who is the all-time leading scorer for Chile?", answer: "Alexis Sanchez", reward: 15 },
    { id: 570, type: "football", question: "Which country won the Euro 2000?", answer: "France", reward: 10 },
    { id: 571, type: "football", question: "Who is the manager of the Portugal national team (as of 2024)?", answer: "Roberto Martinez", reward: 15 },
    { id: 572, type: "football", question: "Which player is nicknamed 'The Baby-Faced Assassin'?", answer: "Ole Gunnar Solskjaer", reward: 15 },
    { id: 573, type: "football", question: "Which team plays at the Wanda Metropolitano?", answer: "Atletico Madrid", reward: 10 },
    { id: 574, type: "football", question: "Who won the Ballon d'Or in 2017?", answer: "Cristiano Ronaldo", reward: 10 },
    { id: 575, type: "football", question: "Which country won the 1966 World Cup?", answer: "England", reward: 5 },
    { id: 576, type: "football", question: "Who is the all-time leading scorer for Manchester United?", answer: "Wayne Rooney", reward: 10 },
    { id: 577, type: "football", question: "Which player is known for his 'No-look' passes?", answer: "Ronaldinho", reward: 10 },
    { id: 578, type: "football", question: "Which club is known as 'The Spurs'?", answer: "Tottenham Hotspur", reward: 5 },
    { id: 579, type: "football", question: "Who won the Golden Boot in the 2018 World Cup?", answer: "Harry Kane", reward: 10 },
    { id: 580, type: "football", question: "Which country won the 1974 World Cup?", answer: "West Germany", reward: 10 },
    { id: 581, type: "football", question: "Who is the all-time leading scorer for Spain?", answer: "David Villa", reward: 10 },
    { id: 582, type: "football", question: "Which player is known as 'The Wall'?", answer: "Oliver Kahn", reward: 15 },
    { id: 583, type: "football", question: "Which club did Luis Suarez play for before Atletico Madrid?", answer: "FC Barcelona", reward: 5 },
    { id: 584, type: "football", question: "Who won the Ballon d'Or in 2019?", answer: "Lionel Messi", reward: 10 },
    { id: 585, type: "football", question: "Which country won the 1982 World Cup?", answer: "Italy", reward: 10 },
    { id: 586, type: "football", question: "Who is the all-time leading scorer for France?", answer: "Olivier Giroud", reward: 10 },
    { id: 587, type: "football", question: "Which player is known as 'The Little Mozart'?", answer: "Tomas Rosicky", reward: 20 },
    { id: 588, type: "football", question: "Which club is known as 'The Bees'?", answer: "Brentford", reward: 10 },
    { id: 589, type: "football", question: "Who won the Golden Boot in the 2014 World Cup?", answer: "James Rodriguez", reward: 15 },
    { id: 590, type: "football", question: "Which country won the 1990 World Cup?", answer: "West Germany", reward: 10 },
    { id: 591, type: "football", question: "Who is the all-time leading scorer for Argentina?", answer: "Lionel Messi", reward: 5 },
    { id: 592, type: "football", question: "Which player is known as 'The White Pele'?", answer: "Zico", reward: 15 },
    { id: 593, type: "football", question: "Which club is known as 'The Cherries'?", answer: "Bournemouth", reward: 10 },
    { id: 594, type: "football", question: "Who won the Golden Boot in the 2010 World Cup?", answer: "Thomas Muller", reward: 15 },
    { id: 595, type: "football", question: "Which country won the 1994 World Cup?", answer: "Brazil", reward: 10 },
    { id: 596, type: "football", question: "Who is the all-time leading scorer for Italy?", answer: "Luigi Riva", reward: 15 },
    { id: 597, type: "football", question: "Which player is known as 'The Black Spider'?", answer: "Lev Yashin", reward: 15 },
    { id: 598, type: "football", question: "Which club is known as 'The Cottagers'?", answer: "Fulham", reward: 10 },
    { id: 599, type: "football", question: "Who won the Golden Boot in the 2006 World Cup?", answer: "Miroslav Klose", reward: 15 },
    { id: 600, type: "football", question: "Which country won the 1998 World Cup?", answer: "France", reward: 10 },
     { id: 400, type: "football", question: "Who is the current captain of England (as of 2024)?", answer: "Harry Kane", reward: 5 },
      { id: 401, type: "football", question: "Which player won the Ballon d'Or in 1998?", answer: "Zinedine Zidane", aliases: ["zidane"], reward: 10 },
      { id: 402, type: "football", question: "Which club does Kevin De Bruyne play for (as of 2024)?", answer: "Manchester City", aliases: ["man city"], reward: 5 },
      { id: 403, type: "football", question: "Who is the all-time leading scorer for Belgium?", answer: "Romelu Lukaku", reward: 15 },
      { id: 404, type: "football", question: "Which country won the 1930 World Cup?", answer: "Uruguay", reward: 15 },
      { id: 405, type: "football", question: "Who is the manager of the Brazil national team (as of 2024)?", answer: "Dorival Junior", reward: 15 },
      { id: 406, type: "football", question: "Which player is nicknamed 'The King'?", answer: "Pele", reward: 5 },
      { id: 407, type: "football", question: "Which team is known as 'The Three Lions'?", answer: "England", reward: 5 },
      { id: 408, type: "football", question: "Who won the Champions League in 2020?", answer: "Bayern Munich", reward: 10 },
      { id: 409, type: "football", question: "Which player is known for the 'Scorpion Kick' goal against Crystal Palace?", answer: "Olivier Giroud", reward: 15 },
      { id: 410, type: "football", question: "Which country won the 1962 World Cup?", answer: "Brazil", reward: 15 },
      { id: 411, type: "football", question: "Who is the all-time top scorer for Uruguay?", answer: "Luis Suarez", aliases: ["suarez"], reward: 10 },
      { id: 412, type: "football", question: "Which club did Lionel Messi join in 2023?", answer: "Inter Miami", reward: 5 },
      { id: 413, type: "football", question: "Who won the Ballon d'Or in 2002?", answer: "Ronaldo Nazario", aliases: ["ronaldo"], reward: 10 },
      { id: 414, type: "football", question: "Which stadium is the home of Manchester United?", answer: "Old Trafford", reward: 5 },
      { id: 415, type: "football", question: "Who is the all-time leading scorer for England?", answer: "Harry Kane", reward: 10 },
      { id: 416, type: "football", question: "Which country won the 1958 World Cup?", answer: "Brazil", reward: 15 },
      { id: 417, type: "football", question: "Who is the manager of the Netherlands national team (as of 2024)?", answer: "Ronald Koeman", aliases: ["koeman"], reward: 10 },
      { id: 418, type: "football", question: "Which player is nicknamed 'El Pulga'?", answer: "Lionel Messi", aliases: ["messi"], reward: 5 },
      { id: 419, type: "football", question: "Which team is known as 'The Sky Blues'?", answer: "Manchester City", reward: 5 },
      { id: 420, type: "football", question: "Who won the Champions League in 2019?", answer: "Liverpool", reward: 10 },
      { id: 421, type: "football", question: "Which player is known for his 'Panenka' penalty in the 2006 World Cup final?", answer: "Zinedine Zidane", aliases: ["zidane"], reward: 15 },
      { id: 422, type: "football", question: "Which country won the 1954 World Cup?", answer: "West Germany", reward: 15 },
      { id: 423, type: "football", question: "Who is the all-time top scorer for Poland?", answer: "Robert Lewandowski", aliases: ["lewandowski"], reward: 10 },
      { id: 424, type: "football", question: "Which club did Neymar join in 2023?", answer: "Al-Hilal", reward: 10 },
      { id: 425, type: "football", question: "Who won the Ballon d'Or in 2001?", answer: "Michael Owen", reward: 15 },
      { id: 426, type: "football", question: "Which stadium is the home of Liverpool?", answer: "Anfield", reward: 5 },
      { id: 427, type: "football", question: "Who is the all-time leading scorer for Argentina?", answer: "Lionel Messi", aliases: ["messi"], reward: 10 },
      { id: 428, type: "football", question: "Which country won the 1950 World Cup?", answer: "Uruguay", reward: 15 },
      { id: 429, type: "football", question: "Who is the manager of the Italy national team (as of 2024)?", answer: "Luciano Spalletti", reward: 15 },
      { id: 430, type: "football", question: "Which player is nicknamed 'CR7'?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 5 },
      { id: 431, type: "football", question: "Which team is known as 'The Red Devils'?", answer: "Manchester United", reward: 5 },
      { id: 432, type: "football", question: "Who won the Champions League in 2018?", answer: "Real Madrid", reward: 10 },
      { id: 433, type: "football", question: "Which player is known for his 'Bicycle Kick' goal against Juventus in 2018?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 15 },
      { id: 434, type: "football", question: "Which country won the 1938 World Cup?", answer: "Italy", reward: 15 },
      { id: 435, type: "football", question: "Who is the all-time top scorer for Chile?", answer: "Alexis Sanchez", reward: 15 },
      { id: 436, type: "football", question: "Which club did Jude Bellingham join in 2023?", answer: "Real Madrid", reward: 10 },
      { id: 437, type: "football", question: "Who won the Ballon d'Or in 2000?", answer: "Luis Figo", reward: 15 },
      { id: 438, type: "football", question: "Which stadium is the home of Bayern Munich?", answer: "Allianz Arena", reward: 10 },
      { id: 439, type: "football", question: "Who is the all-time leading scorer for Portugal?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 5 },
      { id: 440, type: "football", question: "Which country won the 1934 World Cup?", answer: "Italy", reward: 15 },
      { id: 441, type: "football", question: "Who is the manager of the France national team (as of 2024)?", answer: "Didier Deschamps", reward: 10 },
      { id: 442, type: "football", question: "Which player is nicknamed 'The Phenomenon'?", answer: "Ronaldo Nazario", aliases: ["ronaldo"], reward: 5 },
      { id: 443, type: "football", question: "Which team is known as 'The Gunners'?", answer: "Arsenal", reward: 5 },
      { id: 444, type: "football", question: "Who won the Champions League in 2017?", answer: "Real Madrid", reward: 10 },
      { id: 445, type: "football", question: "Which player is known for his 'Hand of God' goal?", answer: "Diego Maradona", aliases: ["maradona"], reward: 10 },
      { id: 446, type: "football", question: "Which country won the 1990 World Cup?", answer: "West Germany", reward: 15 },
      { id: 447, type: "football", question: "Who is the all-time top scorer for Colombia?", answer: "Radamel Falcao", reward: 15 },
      { id: 448, type: "football", question: "Which club did Harry Kane join in 2023?", answer: "Bayern Munich", reward: 10 },
      { id: 449, type: "football", question: "Who won the Ballon d'Or in 1999?", answer: "Rivaldo", reward: 15 },
      { id: 450, type: "football", question: "Who is the all-time leading scorer for Brazil?", answer: "Neymar", aliases: ["neymar jr"], reward: 10 },
      { id: 451, type: "football", question: "Which player won the Ballon d'Or in 1997?", answer: "Ronaldo Nazario", aliases: ["ronaldo"], reward: 10 },
      { id: 452, type: "football", question: "Which club does Mohamed Salah play for (as of 2024)?", answer: "Liverpool", aliases: ["liverpool"], reward: 5 },
      { id: 453, type: "football", question: "Who is the all-time leading scorer for Sweden?", answer: "Zlatan Ibrahimovic", aliases: ["ibrahimovic"], reward: 15 },
      { id: 454, type: "football", question: "Which country won the 2010 World Cup?", answer: "Spain", reward: 10 },
      { id: 455, type: "football", question: "Who is the manager of the Spain national team (as of 2024)?", answer: "Luis de la Fuente", reward: 15 },
      { id: 456, type: "football", question: "Which player is nicknamed 'El Matador'?", answer: "Edinson Cavani", reward: 15 },
      { id: 457, type: "football", question: "Which team is known as 'The Spurs'?", answer: "Tottenham Hotspur", aliases: ["tottenham"], reward: 5 },
      { id: 458, type: "football", question: "Who won the Champions League in 2016?", answer: "Real Madrid", reward: 10 },
      { id: 459, type: "football", question: "Which player is known for his 'No-Look' goals?", answer: "Roberto Firmino", reward: 15 },
      { id: 460, type: "football", question: "Which country won the 1982 World Cup?", answer: "Italy", reward: 15 },
      { id: 461, type: "football", question: "Who is the all-time top scorer for Mexico?", answer: "Javier Hernandez", aliases: ["chicharito"], reward: 15 },
      { id: 462, type: "football", question: "Which club did Declan Rice join in 2023?", answer: "Arsenal", reward: 10 },
      { id: 463, type: "football", question: "Who won the Ballon d'Or in 1996?", answer: "Matthias Sammer", reward: 15 },
      { id: 464, type: "football", question: "Which stadium is the home of Chelsea?", answer: "Stamford Bridge", reward: 10 },
      { id: 465, type: "football", question: "Who is the all-time leading scorer for Ivory Coast?", answer: "Didier Drogba", reward: 15 },
      { id: 466, type: "football", question: "Which country won the 1978 World Cup?", answer: "Argentina", reward: 15 },
      { id: 467, type: "football", question: "Who is the manager of the Portugal national team (as of 2024)?", answer: "Roberto Martinez", reward: 15 },
      { id: 468, type: "football", question: "Which player is nicknamed 'The Magician'?", answer: "Ronaldinho", reward: 10 },
      { id: 469, type: "football", question: "Which team is known as 'The Villans'?", answer: "Aston Villa", reward: 10 },
      { id: 470, type: "football", question: "Who won the Champions League in 2015?", answer: "FC Barcelona", reward: 10 },
      { id: 471, type: "football", question: "Which player is known for his 'Elastic' dribble?", answer: "Ronaldinho", reward: 15 },
      { id: 472, type: "football", question: "Which country won the 1974 World Cup?", answer: "West Germany", reward: 15 },
      { id: 473, type: "football", question: "Who is the all-time top scorer for Cameroon?", answer: "Samuel Eto'o", reward: 15 },
      { id: 474, type: "football", question: "Which club did Kai Havertz join in 2023?", answer: "Arsenal", reward: 10 },
      { id: 475, type: "football", question: "Who won the Ballon d'Or in 1995?", answer: "George Weah", reward: 15 },
      { id: 476, type: "football", question: "Which stadium is the home of Arsenal?", answer: "Emirates Stadium", reward: 10 },
      { id: 477, type: "football", question: "Who is the all-time leading scorer for Ghana?", answer: "Asamoah Gyan", reward: 15 },
      { id: 478, type: "football", question: "Which country won the 1970 World Cup?", answer: "Brazil", reward: 15 },
      { id: 479, type: "football", question: "Who is the manager of the Belgium national team (as of 2024)?", answer: "Domenico Tedesco", reward: 15 },
      { id: 480, type: "football", question: "Which player is nicknamed 'The Iceman'?", answer: "Dennis Bergkamp", reward: 15 },
      { id: 481, type: "football", question: "Which team is known as 'The Toffees'?", answer: "Everton", reward: 10 },
      { id: 482, type: "football", question: "Who won the Champions League in 2014?", answer: "Real Madrid", reward: 10 },
      { id: 483, type: "football", question: "Which player is known for his 'Knuckleball' free-kicks?", answer: "Cristiano Ronaldo", aliases: ["ronaldo"], reward: 15 },
      { id: 484, type: "football", question: "Which country won the 1966 World Cup?", answer: "England", reward: 15 },
      { id: 485, type: "football", question: "Who is the all-time top scorer for Nigeria?", answer: "Rashidi Yekini", reward: 15 },
      { id: 486, type: "football", question: "Which club did Mason Mount join in 2023?", answer: "Manchester United", reward: 10 },
      { id: 487, type: "football", question: "Who won the Ballon d'Or in 1994?", answer: "Hristo Stoichkov", reward: 15 },
      { id: 488, type: "football", question: "Which stadium is the home of Manchester City?", answer: "Etihad Stadium", reward: 10 },
      { id: 489, type: "football", question: "Who is the all-time leading scorer for Senegal?", answer: "Sadio Mane", reward: 15 },
      { id: 490, type: "football", question: "Which country won the 1958 World Cup?", answer: "Brazil", reward: 15 },
      { id: 491, type: "football", question: "Who is the manager of the Croatia national team (as of 2024)?", answer: "Zlatko Dalic", reward: 15 },
      { id: 492, type: "football", question: "Which player is nicknamed 'The General'?", answer: "Zinedine Zidane", aliases: ["zidane"], reward: 15 },
      { id: 493, type: "football", question: "Which team is known as 'The Hammers'?", answer: "West Ham United", aliases: ["west ham"], reward: 10 },
      { id: 494, type: "football", question: "Who won the Champions League in 2013?", answer: "Bayern Munich", reward: 10 },
      { id: 495, type: "football", question: "Which player is known for his 'Samba' style?", answer: "Ronaldinho", reward: 15 },
      { id: 496, type: "football", question: "Which country won the 1954 World Cup?", answer: "West Germany", reward: 15 },
    { id: 497, type: "football", question: "Who is the all-time top scorer for South Korea?", answer: "Cha Bum-kun", reward: 15 },
    { id: 498, type: "football", question: "Which club did James Maddison join in 2023?", answer: "Tottenham Hotspur", reward: 10 },
    { id: 499, type: "football", question: "Who won the Ballon d'Or in 1993?", answer: "Roberto Baggio", reward: 15 },
    { id: 500, type: "football", question: "Who is the all-time leading scorer for France?", answer: "Olivier Giroud", reward: 10 },
    { id: 501, type: "football", question: "Who won the 2024 Euro championship?", answer: "Spain", reward: 10 },
    { id: 502, type: "football", question: "Which player is nicknamed 'The Baby-Faced Assassin'?", answer: "Ole Gunnar Solskjaer", reward: 15 },
    { id: 503, type: "football", question: "Who is the all-time top scorer for the Netherlands?", answer: "Robin van Persie", reward: 10 },
    { id: 504, type: "football", question: "Which club did Cole Palmer join in 2023?", answer: "Chelsea", reward: 10 },
    { id: 505, type: "football", question: "Who won the Ballon d'Or in 1992?", answer: "Marco van Basten", reward: 15 },
    { id: 506, type: "football", question: "Which country hosted the 2006 World Cup?", answer: "Germany", reward: 10 },
    { id: 507, type: "football", question: "Who is the all-time leading scorer for Belgium?", answer: "Romelu Lukaku", reward: 10 },
    { id: 508, type: "football", question: "Which player is known for his 'Cruyff Turn'?", answer: "Johan Cruyff", reward: 10 },
    { id: 509, type: "football", question: "Who won the 2021 Copa America?", answer: "Argentina", reward: 10 },
    { id: 510, type: "football", question: "Which club did Alexis Mac Allister join in 2023?", answer: "Liverpool", reward: 10 },
    { id: 511, type: "football", question: "Who is the all-time top scorer for Japan?", answer: "Kunishige Kamamoto", reward: 20 },
    { id: 512, type: "football", question: "Which country won the 2004 Euro?", answer: "Greece", reward: 20 },
    { id: 513, type: "football", question: "Who is the manager of the England national team (as of late 2024)?", answer: "Thomas Tuchel", reward: 15 },
    { id: 514, type: "football", question: "Which player is nicknamed 'The Non-Flying Dutchman'?", answer: "Dennis Bergkamp", reward: 15 },
    { id: 515, type: "football", question: "Who won the Ballon d'Or in 1991?", answer: "Jean-Pierre Papin", reward: 15 },
    { id: 516, type: "football", question: "Which club did Dominik Szoboszlai join in 2023?", answer: "Liverpool", reward: 10 },
    { id: 517, type: "football", question: "Who is the all-time leading scorer for Switzerland?", answer: "Alexander Frei", reward: 15 },
    { id: 518, type: "football", question: "Which country hosted the 1994 World Cup?", answer: "USA", aliases: ["united states"], reward: 10 },
    { id: 519, type: "football", question: "Who won the Champions League in 2012?", answer: "Chelsea", reward: 10 },
    { id: 520, type: "football", question: "Which player is known for his 'Rabona' goals?", answer: "Erik Lamela", reward: 15 },
    { id: 521, type: "football", question: "Who is the all-time top scorer for USA?", answer: "Clint Dempsey and Landon Donovan", aliases: ["dempsey", "donovan"], reward: 15 },
    { id: 522, type: "football", question: "Which club did Josko Gvardiol join in 2023?", answer: "Manchester City", reward: 10 },
    { id: 523, type: "football", question: "Who won the Ballon d'Or in 1990?", answer: "Lothar Matthaus", reward: 15 },
    { id: 524, type: "football", question: "Which country won the 2015 Asian Cup?", answer: "Australia", reward: 15 },
    { id: 525, type: "football", question: "Who is the manager of the Germany national team (as of 2024)?", answer: "Julian Nagelsmann", reward: 15 },
    { id: 526, type: "football", question: "Which player is nicknamed 'The Atomic Flea'?", answer: "Lionel Messi", reward: 10 },
    { id: 527, type: "football", question: "Who won the Champions League in 2011?", answer: "FC Barcelona", reward: 10 },
    { id: 528, type: "football", question: "Which country hosted the 2002 World Cup?", answer: "South Korea and Japan", reward: 10 },
    { id: 529, type: "football", question: "Who is the all-time top scorer for Australia?", answer: "Tim Cahill", reward: 10 },
    { id: 530, type: "football", question: "Which club did Christopher Nkunku join in 2023?", answer: "Chelsea", reward: 10 },
    { id: 531, type: "football", question: "Who won the Ballon d'Or in 1989?", answer: "Marco van Basten", reward: 15 },
    { id: 532, type: "football", question: "Which country won the 2019 Asian Cup?", answer: "Qatar", reward: 15 },
    { id: 533, type: "football", question: "Who is the all-time leading scorer for Denmark?", answer: "Poul Nielsen and Jon Dahl Tomasson", reward: 20 },
    { id: 534, type: "football", question: "Which player is known for his 'Rainbow Flick'?", answer: "Neymar", reward: 10 },
    { id: 535, type: "football", question: "Who won the Champions League in 2010?", answer: "Inter Milan", reward: 10 },
    { id: 536, type: "football", question: "Which country hosted the 1998 World Cup?", answer: "France", reward: 10 },
    { id: 537, type: "football", question: "Who is the all-time top scorer for Ghana?", answer: "Asamoah Gyan", reward: 10 },
    { id: 538, type: "football", question: "Which club did Sandro Tonali join in 2023?", answer: "Newcastle United", reward: 10 },
    { id: 539, type: "football", question: "Who won the Ballon d'Or in 1988?", answer: "Marco van Basten", reward: 15 },
    { id: 540, type: "football", question: "Which country won the 1996 Euro?", answer: "Germany", reward: 15 },
    { id: 541, type: "football", question: "Who is the all-time leading scorer for Norway?", answer: "Erling Haaland", reward: 5 },
    { id: 542, type: "football", question: "Which player is nicknamed 'The Egyptian King'?", answer: "Mohamed Salah", reward: 5 },
    { id: 543, type: "football", question: "Who won the Champions League in 2009?", answer: "FC Barcelona", reward: 10 },
    { id: 544, type: "football", question: "Which country hosted the 1990 World Cup?", answer: "Italy", reward: 10 },
    { id: 545, type: "football", question: "Who is the all-time top scorer for Wales?", answer: "Gareth Bale", reward: 10 },
    { id: 546, type: "football", question: "Which club did Moussa Diaby join in 2023?", answer: "Aston Villa", reward: 15 },
    { id: 547, type: "football", question: "Who won the Ballon d'Or in 1987?", answer: "Ruud Gullit", reward: 15 },
    { id: 548, type: "football", question: "Which country won the 1992 Euro?", answer: "Denmark", reward: 20 },
    { id: 549, type: "football", question: "Who is the all-time leading scorer for Austria?", answer: "Toni Polster", reward: 15 },
    { id: 550, type: "football", question: "Which player is known for his 'Trivela' passes?", answer: "Ricardo Quaresma", reward: 15 },
    { id: 551, type: "football", question: "Who won the Champions League in 2008?", answer: "Manchester United", reward: 10 },
    { id: 552, type: "football", question: "Which country hosted the 1986 World Cup?", answer: "Mexico", reward: 10 },
    { id: 553, type: "football", question: "Who is the all-time top scorer for Czech Republic?", answer: "Jan Koller", reward: 15 },
    { id: 554, type: "football", question: "Which club did Andre-Frank Zambo Anguissa join in 2023 permanently?", answer: "Napoli", reward: 15 },
    { id: 555, type: "football", question: "Who won the Ballon d'Or in 1986?", answer: "Igor Belanov", reward: 20 },
    { id: 556, type: "football", question: "Which country won the 1988 Euro?", answer: "Netherlands", reward: 15 },
    { id: 557, type: "football", question: "Who is the all-time leading scorer for Turkey?", answer: "Hakan Sukur", reward: 15 },
    { id: 558, type: "football", question: "Which player is nicknamed 'The Ghost'?", answer: "Andres Iniesta", reward: 15 },
    { id: 559, type: "football", question: "Who won the Champions League in 2007?", answer: "AC Milan", reward: 10 },
    { id: 560, type: "football", question: "Which country hosted the 1982 World Cup?", answer: "Spain", reward: 10 },
    { id: 561, type: "football", question: "Who is the all-time top scorer for Hungary?", answer: "Ferenc Puskas", reward: 10 },
    { id: 562, type: "football", question: "Which club did Pedro Porro join in 2023?", answer: "Tottenham Hotspur", reward: 15 },
    { id: 563, type: "football", question: "Who won the Ballon d'Or in 1985?", answer: "Michel Platini", reward: 15 },
    { id: 564, type: "football", question: "Which country won the 1984 Euro?", answer: "France", reward: 15 },
    { id: 565, type: "football", question: "Who is the all-time leading scorer for Greece?", answer: "Nikos Anastopoulos", reward: 20 },
    { id: 566, type: "football", question: "Which player is known for his 'Freekick' against France in 1997?", answer: "Roberto Carlos", reward: 10 },
    { id: 567, type: "football", question: "Who won the Champions League in 2006?", answer: "FC Barcelona", reward: 10 },
    { id: 568, type: "football", question: "Which country hosted the 1978 World Cup?", answer: "Argentina", reward: 10 },
    { id: 569, type: "football", question: "Who is the all-time top scorer for Romania?", answer: "Gheorghe Hagi and Adrian Mutu", reward: 15 },
    { id: 570, type: "football", question: "Which club did Manuel Ugarte join in 2023?", answer: "PSG", reward: 15 },
    { id: 571, type: "football", question: "Who won the Ballon d'Or in 1984?", answer: "Michel Platini", reward: 15 },
    { id: 572, type: "football", question: "Which country won the 1980 Euro?", answer: "West Germany", reward: 15 },
    { id: 573, type: "football", question: "Who is the all-time leading scorer for Scotland?", answer: "Kenny Dalglish and Denis Law", reward: 20 },
    { id: 574, type: "football", question: "Which player is nicknamed 'The Pitbull'?", answer: "Edgar Davids", reward: 15 },
    { id: 575, type: "football", question: "Who won the Champions League in 2005?", answer: "Liverpool", reward: 10 },
    { id: 576, type: "football", question: "Which country hosted the 1974 World Cup?", answer: "West Germany", reward: 10 },
    { id: 577, type: "football", question: "Who is the all-time top scorer for Bulgaria?", answer: "Dimitar Berbatov", reward: 15 },
    { id: 578, type: "football", question: "Which club did Kim Min-jae join in 2023?", answer: "Bayern Munich", reward: 10 },
    { id: 579, type: "football", question: "Who won the Ballon d'Or in 1983?", answer: "Michel Platini", reward: 15 },
    { id: 580, type: "football", question: "Which country won the 1976 Euro?", answer: "Czechoslovakia", reward: 20 },
    { id: 581, type: "football", question: "Who is the all-time leading scorer for Iran?", answer: "Ali Daei", reward: 10 },
    { id: 582, type: "football", question: "Which player is known for his 'Rabona' assist in 2021?", answer: "Erik Lamela", reward: 15 },
    { id: 583, type: "football", question: "Who won the Champions League in 2004?", answer: "FC Porto", reward: 15 },
    { id: 584, type: "football", question: "Which country hosted the 1970 World Cup?", answer: "Mexico", reward: 10 },
    { id: 585, type: "football", question: "Who is the all-time top scorer for Peru?", answer: "Paolo Guerrero", reward: 15 },
    { id: 586, type: "football", question: "Which club did Micky van de Ven join in 2023?", answer: "Tottenham Hotspur", reward: 15 },
    { id: 587, type: "football", question: "Who won the Ballon d'Or in 1982?", answer: "Paolo Rossi", reward: 15 },
    { id: 588, type: "football", question: "Which country won the 1972 Euro?", answer: "West Germany", reward: 15 },
    { id: 589, type: "football", question: "Who is the all-time leading scorer for South Africa?", answer: "Benni McCarthy", reward: 15 },
    { id: 590, type: "football", question: "Which player is nicknamed 'The Little Prince'?", answer: "Antoine Griezmann", reward: 10 },
    { id: 591, type: "football", question: "Who won the Champions League in 2003?", answer: "AC Milan", reward: 10 },
    { id: 592, type: "football", question: "Which country hosted the 1966 World Cup?", answer: "England", reward: 10 },
    { id: 593, type: "football", question: "Who is the all-time top scorer for Paraguay?", answer: "Roque Santa Cruz", reward: 15 },
    { id: 594, type: "football", question: "Which club did Jurrien Timber join in 2023?", answer: "Arsenal", reward: 15 },
    { id: 595, type: "football", question: "Who won the Ballon d'Or in 1981?", answer: "Karl-Heinz Rummenigge", reward: 15 },
    { id: 596, type: "football", question: "Which country won the 1968 Euro?", answer: "Italy", reward: 15 },
    { id: 597, type: "football", question: "Who is the all-time leading scorer for Ukraine?", answer: "Andriy Shevchenko", reward: 10 },
    { id: 598, type: "football", question: "Which player is known for his 'Panenka' in Euro 1976?", answer: "Antonin Panenka", reward: 15 },
    { id: 599, type: "football", question: "Who won the Champions League in 2002?", answer: "Real Madrid", reward: 10 },
    { id: 600, type: "football", question: "Which country hosted the 1962 World Cup?", answer: "Chile", reward: 15 },
    // Basketball Quiz (601-900)
    { id: 601, type: "basketball", question: "Who holds the record for most points in a single NBA game?", answer: "Wilt Chamberlain", reward: 10 },
    { id: 602, type: "basketball", question: "Which team has won the most NBA championships?", answer: "Boston Celtics", reward: 5 },
    { id: 603, type: "basketball", question: "Who is the NBA's all-time leading scorer?", answer: "LeBron James", reward: 5 },
    { id: 604, type: "basketball", question: "How many championships did Michael Jordan win with the Bulls?", answer: "6", reward: 10 },
    { id: 605, type: "basketball", question: "Which player is known as 'The Black Mamba'?", answer: "Kobe Bryant", reward: 5 },
    { id: 606, type: "basketball", question: "Which team does Stephen Curry play for?", answer: "Golden State Warriors", reward: 5 },
    { id: 607, type: "basketball", question: "What is the height of a regulation NBA hoop?", answer: "10 feet", reward: 10 },
    { id: 608, type: "basketball", question: "Who won the NBA MVP in 2023?", answer: "Joel Embiid", reward: 10 },
    { id: 609, type: "basketball", question: "Which player has the most career assists in NBA history?", answer: "John Stockton", reward: 15 },
    { id: 610, type: "basketball", question: "What city do the Lakers play in?", answer: "Los Angeles", reward: 5 },
    { id: 611, type: "basketball", question: "Who is the logo of the NBA?", answer: "Jerry West", reward: 15 },
    { id: 612, type: "basketball", question: "How many points is a free throw worth?", answer: "1", reward: 5 },
    { id: 613, type: "basketball", question: "Which team won the first-ever NBA championship?", answer: "Philadelphia Warriors", reward: 20 },
    { id: 614, type: "basketball", question: "Who is the all-time leader in 3-pointers made?", answer: "Stephen Curry", reward: 5 },
    { id: 615, type: "basketball", question: "Which player is nicknamed 'The Greek Freak'?", answer: "Giannis Antetokounmpo", reward: 5 },
    { id: 616, type: "basketball", question: "What is the distance of the NBA 3-point line at its furthest point?", answer: "23.75 feet", reward: 15 },
    { id: 617, type: "basketball", question: "Who won the 2024 NBA Championship?", answer: "Boston Celtics", reward: 10 },
    { id: 618, type: "basketball", question: "Which player was the #1 overall pick in the 2023 NBA Draft?", answer: "Victor Wembanyama", reward: 10 },
    { id: 619, type: "basketball", question: "Who is the head coach of the Golden State Warriors?", answer: "Steve Kerr", reward: 10 },
    { id: 620, type: "basketball", question: "How many minutes are in a regulation NBA quarter?", answer: "12", reward: 5 },
    { id: 621, type: "basketball", question: "Which player is known as 'The Answer'?", answer: "Allen Iverson", reward: 10 },
    { id: 622, type: "basketball", question: "Which team does Luka Doncic play for?", answer: "Dallas Mavericks", reward: 5 },
    { id: 623, type: "basketball", question: "Who won the most NBA titles as a player?", answer: "Bill Russell", reward: 15 },
    { id: 624, type: "basketball", question: "What is the name of the NBA's minor league?", answer: "G League", reward: 10 },
    { id: 625, type: "basketball", question: "Which player has the most career rebounds?", answer: "Wilt Chamberlain", reward: 15 },
    { id: 626, type: "basketball", question: "Who is the current commissioner of the NBA?", answer: "Adam Silver", reward: 10 },
    { id: 627, type: "basketball", question: "Which team plays at Madison Square Garden?", answer: "New York Knicks", reward: 5 },
    { id: 628, type: "basketball", question: "Who was the first player to be unanimous MVP?", answer: "Stephen Curry", reward: 15 },
    { id: 629, type: "basketball", question: "Which player is known as 'Magic'?", answer: "Earvin Johnson", reward: 5 },
    { id: 630, type: "basketball", question: "What is the maximum number of players on an NBA active roster?", answer: "15", reward: 15 },
    { id: 631, type: "basketball", question: "Which player has the most points in a single playoff game?", answer: "Michael Jordan", reward: 15 },
    { id: 632, type: "basketball", question: "Which team did Shaquille O'Neal win his first championship with?", answer: "Los Angeles Lakers", reward: 10 },
    { id: 633, type: "basketball", question: "Who is the only player to win 10 scoring titles?", answer: "Michael Jordan", reward: 15 },
    { id: 634, type: "basketball", question: "Which team is known as the 'Bad Boys'?", answer: "Detroit Pistons", reward: 10 },
    { id: 635, type: "basketball", question: "Who was the first European player to win NBA MVP?", answer: "Dirk Nowitzki", reward: 15 },
    { id: 636, type: "basketball", question: "Which player is known as 'The Process'?", answer: "Joel Embiid", reward: 5 },
    { id: 637, type: "basketball", question: "How many fouls does it take to get fouled out in an NBA game?", answer: "6", reward: 5 },
    { id: 638, type: "basketball", question: "Which team does Ja Morant play for?", answer: "Memphis Grizzlies", reward: 5 },
    { id: 639, type: "basketball", question: "Who is the youngest player to score 30,000 career points?", answer: "LeBron James", reward: 15 },
    { id: 640, type: "basketball", question: "Which player is nicknamed 'Dame Time'?", answer: "Damian Lillard", reward: 5 },
    { id: 641, type: "basketball", question: "Which team won the 2016 NBA Finals after being down 3-1?", answer: "Cleveland Cavaliers", reward: 10 },
    { id: 642, type: "basketball", question: "Who is the all-time leader in blocked shots?", answer: "Hakeem Olajuwon", reward: 15 },
    { id: 643, type: "basketball", question: "Which player is known as 'The Big Fundamental'?", answer: "Tim Duncan", reward: 10 },
    { id: 644, type: "basketball", question: "How many teams are in the NBA?", answer: "30", reward: 5 },
    { id: 645, type: "basketball", question: "Which player is nicknamed 'Spida'?", answer: "Donovan Mitchell", reward: 10 },
    { id: 646, type: "basketball", question: "Who won the 2022 NBA Finals MVP?", answer: "Stephen Curry", reward: 10 },
    { id: 647, type: "basketball", question: "Which team did Kevin Durant join in 2016?", answer: "Golden State Warriors", reward: 5 },
    { id: 648, type: "basketball", question: "Who is the all-time leader in triple-doubles?", answer: "Russell Westbrook", reward: 10 },
    { id: 649, type: "basketball", question: "Which player is known as 'The Truth'?", answer: "Paul Pierce", reward: 10 },
    { id: 650, type: "basketball", question: "Which team does Anthony Edwards play for?", answer: "Minnesota Timberwolves", reward: 5 },
    { id: 651, type: "basketball", question: "Who was the #1 pick in the 2003 NBA Draft?", answer: "LeBron James", reward: 5 },
    { id: 652, type: "basketball", question: "Which player is nicknamed 'CP3'?", answer: "Chris Paul", reward: 5 },
    { id: 653, type: "basketball", question: "Which team plays at the United Center?", answer: "Chicago Bulls", reward: 10 },
    { id: 654, type: "basketball", question: "Who is the all-time leading scorer for the Chicago Bulls?", answer: "Michael Jordan", reward: 5 },
    { id: 655, type: "basketball", question: "Which player is known as 'The Admiral'?", answer: "David Robinson", reward: 15 },
    { id: 656, type: "basketball", question: "Which team did Kawhi Leonard lead to a title in 2019?", answer: "Toronto Raptors", reward: 10 },
    { id: 657, type: "basketball", question: "Who is the only player to record a 100-point game?", answer: "Wilt Chamberlain", reward: 5 },
    { id: 658, type: "basketball", question: "Which player is nicknamed 'The Slim Reaper'?", answer: "Kevin Durant", reward: 10 },
    { id: 659, type: "basketball", question: "Which team won the 2021 NBA Championship?", answer: "Milwaukee Bucks", reward: 10 },
    { id: 660, type: "basketball", question: "Who is the head coach of the Miami Heat?", answer: "Erik Spoelstra", reward: 15 },
    // Boxing Quiz (901-1200)
    { id: 901, type: "boxing", question: "Who is known as 'The Greatest'?", answer: "Muhammad Ali", reward: 5 },
    { id: 902, type: "boxing", question: "Who holds the record for the most heavyweight title defenses?", answer: "Joe Louis", reward: 15 },
    { id: 903, type: "boxing", question: "Which boxer is nicknamed 'Iron Mike'?", answer: "Mike Tyson", reward: 5 },
    { id: 904, type: "boxing", question: "How many weight classes did Manny Pacquiao win titles in?", answer: "8", reward: 15 },
    { id: 905, type: "boxing", question: "Who defeated Muhammad Ali in the 'Fight of the Century'?", answer: "Joe Frazier", reward: 15 },
    { id: 906, type: "boxing", question: "Which boxer is known as 'The Golden Boy'?", answer: "Oscar De La Horna", reward: 10 },
    { id: 907, type: "boxing", question: "What is the standard length of a professional boxing round?", answer: "3 minutes", reward: 5 },
    { id: 908, type: "boxing", question: "Who is the only undefeated heavyweight champion to retire at 49-0?", answer: "Rocky Marciano", reward: 15 },
    { id: 909, type: "boxing", question: "Which boxer is nicknamed 'Money'?", answer: "Floyd Mayweather", reward: 5 },
    { id: 910, type: "boxing", question: "Who won the 'Rumble in the Jungle'?", answer: "Muhammad Ali", reward: 10 }
];

const SHOP = [
    { name: 'Chess Beginner', description: 'Starter role for new players.', price: 25, roleId: '1455250623510614157' },
    { name: 'Chess Improver', description: 'Shows dedication to improving.', price: 75, roleId: '1455250690892107961' },
    { name: 'Chess Pro', description: 'Recognizes strong consistent play.', price: 200, roleId: '1455250740653330453' },
    { name: 'Chess Master', description: 'Highlights elite skill and strategy.', price: 500, roleId: '1455250877999747214' },
    { name: 'Chess GOAT', description: 'Top-tier recognition across the server.', price: 1000, roleId: '1455250931473191148' }
];

const PLAYERS_CHESS_TEXT = `
1. Magnus Carlsen
Youngest world No. 1 in history
Dominated classical, rapid, and blitz simultaneously
Slammed the table vs Gukesh (2023)
Voluntarily gave up the world title
Famous for squeezing wins from equal endgames
2. Garry Kasparov
Youngest world champion at the time
Symbol of aggressive, dynamic chess
Historic matches vs Deep Blue
Ruled the rating list for over 20 years
Became a political activist after retiring
3. Bobby Fischer
Only American world champion
Ended Soviet dominance in 1972
Perfect 6–0–6 Candidates run
Extremely controversial personality
Vanished from elite chess after his title
4. Anatoly Karpov
Master of prophylactic chess
Became world champion without a match (1975)
Legendary rivalry with Kasparov
Incredible tournament consistency
Famous for slowly suffocating opponents
5. Vladimir Kramnik
Ended Kasparov’s reign
Popularized the Berlin Defense
Deep positional understanding
Later involved in cheating controversies
Elite opening theoretician
6. Viswanathan Anand
India’s first world champion
Extremely fast calculator
World champion in three different formats
Known for mental resilience
National icon in India
7. Hikaru Nakamura
One of the best blitz players ever
Twitch & YouTube chess superstar
Known for speed and trash talk
Candidates comeback in 2022
Online chess legend
8. Fabiano Caruana
Came closest to beating Magnus (2018)
Rating peak over 2840
Extremely precise opening prep
Known for deep preparation
Calm, analytical style
9. Ding Liren
China’s first world champion
Famous 100+ game unbeaten streak
Very calm playing style
Overcame serious mental struggles
Elite defender
10. Alireza Firouzja
Youngest player to reach 2800
Switched federations from Iran to France
Ultra-aggressive style
Fashion designer on the side
Touted as a future world champion
11. Mikhail Tal
“The Magician from Riga”
Sacrificed pieces without full calculation
World champion in 1960
Pure intuition and chaos
Crowd favorite
12. José Raúl Capablanca
Natural chess genius
Minimal theory, maximum dominance
Legendary endgame technique
Very long unbeaten streaks
Third world champion
13. Emanuel Lasker
Longest-reigning world champion (27 years)
Philosopher and mathematician
Psychological approach to chess
Defeated multiple generations
Extremely pragmatic
14. Alexander Alekhine
Ferocious attacking world champion
Never lost the title over the board
Namesake of the Alekhine Defense
Brilliant combinations
Tragic personal life
15. Mikhail Botvinnik
Father of the Soviet chess school
Multiple-time world champion
Mentor to Karpov and Kasparov
Scientific approach to chess
Dominated post-war chess
16. Wesley So
Known for sportsmanship
Elite endgame technician
Olympiad champion with the USA
Calm and disciplined style
Strong mental control
17. Ian Nepomniachtchi
Multiple Candidates winner
Extremely fast decision-maker
Collapsed in world championship matches
Highly creative
Childhood rival of Magnus
18. Levon Aronian
One of the most beloved players
Creative sacrifices
Olympiad champion with Armenia
Known for humor
Universal playing style
19. Sergey Karjakin
Youngest grandmaster ever
World championship challenger (2016)
Defensive monster
Political controversies
Extremely resilient
20. Teimour Radjabov
Beat Kasparov at age 15
Extremely solid openings
Longtime Candidates contender
Cautious playing style
Strong comeback after long break
21. Paul Morphy
Greatest talent of the 19th century
Dominated Europe and America
Attacking genius
Retired very early
Legend without a world title
22. Judit Polgár
Strongest female player ever
Defeated multiple world champions
Never played women-only events
Aggressive attacking style
Broke gender barriers
23. Max Euwe
Mathematician world champion
Known for fair play
Defeated Alekhine
Later became FIDE president
Logical, structured style
24. Boris Spassky
Gentleman world champion
Lost the legendary match vs Fischer
Universal playing style
Politically neutral
Elegant chess
25. Veselin Topalov
Extremely aggressive player
Dominated San Luis 2005
World champion that year
Involved in the Kramnik controversy
Tactical powerhouse
26. Shakhriyar Mamedyarov
Always plays for a win
Wild, tactical games
Fan favorite
Explosive attacks
High-risk style
27. Anish Giri
Opening theory expert
Famous for chess memes
Extremely solid
Long unbeaten streaks
Elite preparation
28. Gukesh D
Youngest world championship challenger
Defeated Magnus multiple times
Part of India’s golden generation
Fearless under pressure
Calm personality
29. Praggnanandhaa
Beat Magnus as a teenager
Rapid learner
Strong calculator
Olympiad hero
Remarkable maturity
30. Vidit Gujrathi
Candidates participant
Very solid player
Excellent team competitor
Long underrated
Universal style
31. Richard Rapport
Eccentric opening choices
Highly creative
Known for colorful outfits
Chaos-driven chess
Artistic approach
32. Jan-Krzysztof Duda
Ended Magnus’ unbeaten streak
World Cup finalist
Strong rapid player
Fearless competitor
Excellent endgames
33. Yi Wei
Chinese elite grandmaster
Positional expert
Low media presence
Strong middlegames
Very solid
34. Samuel Reshevsky
Child prodigy
Tactical fighter
American legend
Orthodox Jewish faith
Extremely long career
35. Tigran Petrosian
Defensive genius
Nicknamed “Iron Tigran”
Sacrificed for defense
Very hard to beat
Prophylaxis master
36. David Bronstein
Nearly became world champion
Creative thinker
Major theoretical innovator
Influential author
Famous sacrifice ideas
37. Bent Larsen
Western chess hope
Highly original openings
Challenged Soviet dominance
Fearless attacker
Unorthodox style
38. Peter Svidler
Grünfeld Defense expert
Top-level commentator
Multiple-time Russian champion
Known for humor
Elite theoretician
39. Wesley So
Multiple-time rapid world champion
Endgame machine
Extremely clean technique
Rarely blunders
Ice-cold nerves
40. Hou Yifan
Strongest active female player
Competed regularly vs top GMs
Academic career alongside chess
Strategic style
Global role model
41. Fischer
Invented Fischer Random (Chess960)
Hated quick draws
Opening innovator
Endgame perfectionist
Absolute perfectionist mindset
42. Viktor Korchnoi
Fierce lifelong fighter
Political defector
Extreme willpower
Never became world champion
Legendary mental toughness
43. Daniil Dubov
Creative Carlsen second
Loves sacrifices
Modern attacking ideas
Blitz specialist
Highly unconventional
44. Arjun Erigaisi
One of the fastest rating climbs ever
Extremely aggressive
New-generation star
Fearless approach
Strong calculation
45. Nihal Sarin
Blitz prodigy
Lightning-fast moves
Online chess monster
Tactical vision
Very young elite
46. Gata Kamsky
World championship finalist
Legendary comeback story
Calm personality
Solid style
Long elite career
47. Alexander Grischuk
Famous for time trouble
Elite blitz player
Very humorous
Risk-taking style
Massive experience
48. Nodirbek Abdusattorov
World Rapid Champion (2021)
Known for nerves of steel
Leading the new generation
Incredible defensive skills
Extremely focused
49. Dommaraju Gukesh
Youngest Candidates winner
Challenged for the world title
Extremely mature for his age
Part of India's golden era
Incredible calculation speed
50. Rameshbabu Praggnanandhaa
Broke into the elite as a teenager
Known for deep preparation
Beat Magnus multiple times in rapid
Olympiad gold medalist
Incredible endgame player
`;

const PLAYERS_FOOTBALL_TEXT = `
1. Lionel Messi
8 Ballon d'Or awards
Won the 2022 World Cup with Argentina
Spent most of his career at FC Barcelona
Often called "La Pulga"
Known for incredible dribbling and playmaking
2. Cristiano Ronaldo
All-time leading goalscorer in international football
Won 5 Champions League titles
Played for Man Utd, Real Madrid, Juventus, Al-Nassr
Famous for his "Siuuu" celebration
Incredible athleticism and work ethic
3. Pele
Only player to win 3 World Cups
Scored over 1000 goals in his career
Brazilian legend who played for Santos
Named "Athlete of the Century"
Global ambassador for football
4. Diego Maradona
Scored the "Hand of God" goal
Led Argentina to 1986 World Cup victory
Legendary status at Napoli
One of the greatest dribblers ever
Known for the "Goal of the Century"
5. Zinedine Zidane
Scored twice in the 1998 World Cup final
Famous headbutt in 2006 final
Won the Champions League as both player and manager
Master of elegance and technique
French midfield maestro
6. Kylian Mbappe
Scored a hat-trick in a World Cup final
Known for lightning speed
Won the World Cup at age 19
Plays for Real Madrid (formerly PSG)
French national team captain
7. Erling Haaland
Broke the Premier League single-season scoring record
Known as "The Terminator"
Plays for Manchester City
Incredible physical strength and finishing
Norwegian goal machine
8. Ronaldinho
Always played with a smile
Won the 2005 Ballon d'Or
Master of tricks and "Joga Bonito"
Barcelona and Brazil icon
Known for the elastico and overhead kicks
9. Neymar Jr
Brazil's all-time leading scorer
World's most expensive transfer to PSG
Part of the famous MSN trio at Barca
Incredible flair and skill
Won the Olympic gold for Brazil
10. Robert Lewandowski
Scored 5 goals in 9 minutes
Legendary striker for Bayern Munich and Barca
Polish national team captain
Known for clinical finishing
Won the FIFA Best Player twice
11. Luka Modric
Led Croatia to the 2018 World Cup final
Won the 2018 Ballon d'Or
Real Madrid midfield engine
Known for outside-of-the-boot passes
Incredible longevity at the top level
12. Karim Benzema
2022 Ballon d'Or winner
Second all-time scorer for Real Madrid
Won 5 Champions League titles
Known for link-up play and finishing
Former French national team striker
13. Kevin De Bruyne
Master of assists in the Premier League
Manchester City's creative heartbeat
Known for pinpoint crossing and vision
Belgian midfield superstar
Considered one of the best passers ever
14. Mohamed Salah
Liverpool's all-time Premier League scorer
Known as the "Egyptian King"
Multiple Golden Boot winner
Famous for his speed and left foot
National hero in Egypt
15. Harry Kane
England's all-time leading scorer
Joined Bayern Munich from Tottenham
One of the best all-round strikers
Known for passing range and finishing
England national team captain
16. Virgil van Dijk
Considered one of the best defenders ever
Transformed Liverpool's defense
Known for his composure and aerial strength
Dutch national team captain
UEFA Men's Player of the Year 2019
17. Manuel Neuer
Revolutionized the "Sweeper Keeper" role
Won the 2014 World Cup with Germany
Bayern Munich legend
Known for incredible reflexes and distribution
One of the greatest goalkeepers ever
18. Sergio Ramos
Legendary defender for Real Madrid and Spain
Known for scoring clutch headers
Won 4 Champions League titles
Aggressive and leadership-focused style
Most capped player for Spain
19. Andres Iniesta
Scored the winning goal in the 2010 World Cup final
Barcelona's midfield magician
Known for his "La Croqueta" move
Unbelievable control in tight spaces
Won every major trophy possible
20. Xavi Hernandez
The architect of Tiki-Taka
Barcelona's midfield brain
Known for 360-degree vision
Incredible pass accuracy
Managed Barcelona after retiring
21. Thierry Henry
Arsenal's all-time leading scorer
Part of the "Invincibles" team
Known for his pace and clinical finishing
French legend who won the 1998 World Cup
Famous for his va-va-voom style
22. Luis Suarez
Won the Golden Shoe twice in Messi/Ronaldo era
Part of the MSN trio
Known for his tenacity and finishing
Uruguay's all-time leading scorer
Incredible goal against Norwich (many of them)
23. Gianluigi Buffon
Played in 5 World Cups
Juventus and Italy legend
Won the 2006 World Cup
Known for his longevity and leadership
One of the greatest shot-stoppers
24. Kaka
Last player to win Ballon d'Or before Messi/Ronaldo era
AC Milan legend
Incredible pace with the ball
Won the 2002 World Cup with Brazil
Graceful attacking midfielder
25. Steven Gerrard
Liverpool's legendary captain
Inspired the "Miracle of Istanbul"
Known for powerful long-range goals
One of the best box-to-box midfielders
Played his entire career for one club (mostly)
26. Frank Lampard
Chelsea's all-time leading scorer as a midfielder
Known for his late runs into the box
Incredible goal-scoring record
Won the Champions League in 2012
High footballing IQ
27. Wayne Rooney
Man Utd's all-time leading scorer
Known for his overhead kick vs Man City
Burst onto the scene at Euro 2004
Won every major club trophy
Tenacious and versatile forward
28. David Beckham
Famous for his free-kicks and crossing
Global icon who played for Man Utd, Real Madrid, LA Galaxy
Known for the "Bend it like Beckham" technique
Captain of England for many years
Part of the Class of '92
29. Iker Casillas
Captained Spain to 2 Euro titles and 1 World Cup
Real Madrid's "Saint Iker"
Known for incredible saves
One of the most successful goalkeepers
Won 3 Champions League titles
30. Paolo Maldini
Spent 25 seasons at AC Milan
One of the greatest defenders of all time
Known for his reading of the game
Won 5 Champions League titles
Rarely ever had to make a tackle
31. Johan Cruyff
The father of "Total Football"
Ajax and Barcelona legend
Invented the "Cruyff Turn"
Won 3 Ballon d'Ors
Revolutionized the game as a manager
32. Franz Beckenbauer
Nicknamed "Der Kaiser"
Won the World Cup as both player and manager
Invented the modern Libero role
Bayern Munich and Germany legend
Incredible elegance on the ball
33. George Best
Known as the "Fifth Beatle"
Manchester United legend
Incredible dribbling ability
Won the Ballon d'Or in 1968
"Maradona good, Pele better, George Best"
34. Eusebio
The "Black Panther" of Portuguese football
Benfica legend
Top scorer of the 1966 World Cup
Incredible power and speed
First great African-born superstar
35. Gerd Muller
Nicknamed "Der Bomber"
Incredible goal-per-game ratio
Scored the winner in the 1974 World Cup final
Bayern Munich's greatest ever scorer
Master of the penalty area
36. Marco van Basten
Scored an incredible volley in Euro 1988 final
Won 3 Ballon d'Ors
Career cut short by injury at age 28
AC Milan and Ajax legend
The complete striker
37. Michel Platini
Won 3 consecutive Ballon d'Ors
Led France to Euro 1984 victory
Midfield playmaker with incredible scoring record
Juventus legend
Former UEFA president
38. Rivaldo
Won the 2002 World Cup with Brazil
Famous for his overhead kick vs Valencia
Incredible left foot
Won the 1999 Ballon d'Or
Barcelona legend
39. Cafu
Only player to play in 3 World Cup finals
Most capped player for Brazil
Legendary attacking right-back
Won 2 World Cups
Known for his incredible stamina
40. Roberto Carlos
Famous for his "impossible" free-kick vs France
Incredible power in his left foot
Real Madrid and Brazil legend
Revolutionized the attacking left-back role
Known for his massive thighs
41. Zlatan Ibrahimovic
Scored over 500 career goals
Known for his acrobatic strikes
Played for Ajax, Juve, Inter, Barca, Milan, PSG, Utd
"Zlatan doesn't do auditions"
Iconic personality and confidence
42. Toni Kroos
The "Sniper" of midfield
Won 6 Champions League titles
Known for his incredible passing accuracy
German legend who won the 2014 World Cup
Retired at the top of his game in 2024
43. Antoine Griezmann
Key player in France's 2018 World Cup win
Atletico Madrid's all-time scorer
Versatile forward with high work rate
Known for his creativity and finishing
Nicknamed "Grizi"
44. Son Heung-min
First Asian player to win the PL Golden Boot
Tottenham Hotspur captain
Known for his incredible finishing with both feet
Global icon for South Korean football
Famous "camera" celebration
45. Jude Bellingham
Real Madrid's new superstar
Burst onto the scene at Birmingham City
Incredible maturity for his age
Known for his box-to-box play and goals
Future England captain contender
46. Vinicius Jr
Scored the winning goal in 2022 CL final
Known for his incredible speed and dribbling
Real Madrid's main attacking threat
Brazilian flair and confidence
Face of the fight against racism in football
47. Rodri
Manchester City's midfield anchor
Scored the winner in the 2023 CL final
Known for his tactical intelligence and passing
Unbeatable when he starts for City
Spanish national team core
48. Bukayo Saka
Arsenal's "Starboy"
Key player for England
Known for his dribbling and crossing
Incredible character and resilience
Left-footed winger
49. Phil Foden
The "Stockport Iniesta"
Manchester City academy graduate
Known for his close control and vision
PL Player of the Season 2023/24
Incredible technical ability
50. Alisson Becker
Liverpool's reliable goalkeeper
Known for his incredible one-on-one saves
Scored a last-minute header to save Liverpool's season
Brazilian national team number one
Calm and composed under pressure
`;

const PLAYERS_BASKETBALL_TEXT = `
1. Michael Jordan
6-time NBA champion
Never lost an NBA Final
The "GOAT" for many
Famous for his Air Jordan brand
Played for the Chicago Bulls
2. LeBron James
NBA's all-time leading scorer
Won championships with 3 different teams
Known as "The King"
Incredible longevity and versatility
Played for Cavs, Heat, Lakers
3. Kobe Bryant
The "Black Mamba"
Won 5 championships with the Lakers
Scored 81 points in a single game
Known for his "Mamba Mentality"
Legendary work ethic and scoring
4. Stephen Curry
Revolutionized the game with the 3-pointer
All-time leader in 3-pointers made
2-time NBA MVP
Won 4 championships with the Warriors
Best shooter in history
5. Shaquille O'Neal
Most dominant physical force in history
Nicknamed "Shaq"
Won 3-peat with the Lakers
Famous for breaking backboards
Larger-than-life personality
6. Magic Johnson
Best point guard in history
Led the "Showtime" Lakers
Won 5 NBA championships
Incredible passing and vision
Famous rivalry with Larry Bird
7. Larry Bird
"Larry Legend"
3-time NBA champion with the Celtics
Incredible shooter and trash talker
Won 3 consecutive MVPs
Boston Celtics icon
8. Kareem Abdul-Jabbar
Held the scoring record for 39 years
Invented the "Skyhook"
Won 6 NBA championships
6-time NBA MVP
Lakers and Bucks legend
9. Kevin Durant
"The Slim Reaper"
One of the greatest scorers ever
2-time NBA champion
Known for his unguardable jump shot
Played for Thunder, Warriors, Nets, Suns
10. Giannis Antetokounmpo
The "Greek Freak"
2-time NBA MVP
Led the Bucks to the 2021 championship
Incredible athleticism and drive
From selling watches in Greece to NBA superstardom
11. Nikola Jokic
The "Joker"
3-time NBA MVP
Led the Nuggets to their first title in 2023
Best passing center in history
Known for his unique, slow-paced style
12. Luka Doncic
Slovenian superstar
Known for his incredible scoring and passing
Plays for the Dallas Mavericks
Made the All-NBA First Team multiple times
"Luka Magic"
13. Bill Russell
Won 11 NBA championships
The greatest winner in sports history
Boston Celtics legend
Incredible defensive player
NBA Finals MVP trophy is named after him
14. Wilt Chamberlain
Once scored 100 points in a game
Averaged 50 points per game in a season
Only player to grab 55 rebounds in a game
"The Big Dipper"
Incredible physical records
15. Tim Duncan
"The Big Fundamental"
5-time NBA champion with the Spurs
Best power forward ever
Known for his bank shot and quiet leadership
Played his entire 19-year career with the Spurs
16. Allen Iverson
"The Answer"
Pound-for-pound one of the greatest
Famous for his "crossover"
Iconic style and influence on culture
Played for the 76ers
17. Dwyane Wade
"Flash"
3-time NBA champion with the Heat
Incredible shot-blocking guard
Legendary 2006 Finals performance
Miami Heat icon
18. Dirk Nowitzki
Greatest European player ever
Led the Mavs to 2011 championship
Famous for his one-legged fadeaway
Played 21 seasons for the Mavericks
One of the best shooting big men
19. Hakeem Olajuwon
"The Dream"
Invented the "Dream Shake"
2-time NBA champion with the Rockets
Best defensive player and post-scorer
Born in Nigeria
20. Julius Erving
"Dr. J"
Revolutionized the dunk
Incredible style and grace
ABA and NBA legend
Played for the 76ers
21. Jerry West
"The Logo" (literally the NBA logo)
Lakers legend
Known for his clutch shooting
Only player to win Finals MVP on losing team
Incredible executive after retiring
22. Oscar Robertson
"The Big O"
First player to average a triple-double
NBA champion with the Bucks
Incredible all-around player
Cincinnati Royals legend
23. James Harden
"The Beard"
Incredible scoring and isolation play
Former NBA MVP
Known for his step-back 3-pointer
Led the league in scoring 3 times
24. Russell Westbrook
Averaged a triple-double for 4 seasons
All-time leader in triple-doubles
"Mr. Triple Double"
Incredible intensity and athleticism
Former NBA MVP
25. Kawhi Leonard
"The Klaw"
2-time Finals MVP with different teams
Led Raptors to their first title in 2019
Best two-way player in the league
Quiet and stoic personality
26. Chris Paul
"CP3" or "Point God"
One of the best traditional point guards
Incredible leadership and IQ
High assist and steal numbers
Led many teams to their best seasons
27. Anthony Davis
"AD" or "The Brow"
NBA champion with the Lakers
Incredible defensive presence and scoring
Known for his versatility as a big man
Former No. 1 overall pick
28. Joel Embiid
"The Process"
2023 NBA MVP
Dominant scoring center for the 76ers
Known for his social media presence
Born in Cameroon
29. Jayson Tatum
The face of the Boston Celtics
Led the Celtics to the 2024 championship
Incredible scoring ability
Young superstar mentored by Kobe
Smooth offensive game
30. Kyrie Irving
Best ball-handler in NBA history
Scored the winning shot in 2016 Finals
Incredible finishing at the rim
Known for his flashy and creative play
Won a title with LeBron
31. Damian Lillard
"Dame Time"
Known for his deep 3-pointers and clutch shots
Plays for the Bucks (formerly Blazers)
One of the best scoring guards
Famous "wave goodbye" after series winner
32. Paul George
"PG-13"
One of the best two-way wings
Known for his smooth offensive game
Overcame a horrific leg injury
Plays for the 76ers (formerly Clippers, Pacers)
33. Jimmy Butler
"Jimmy Buckets"
Led the Heat to two NBA Finals
Incredible playoff performer
Known for his tough and gritty style
Started his own coffee brand "Big Face Coffee"
34. Ja Morant
Incredible high-flying dunks
Plays for the Memphis Grizzlies
Known for his speed and athleticism
NBA Rookie of the Year 2020
Exciting and explosive playstyle
35. Victor Wembanyama
"Wemby"
Tallest player in the league with guard skills
Incredible hype before entering the NBA
Plays for the San Antonio Spurs
The future face of the NBA
36. Zion Williamson
Most hyped prospect since LeBron
Incredible power and leaping ability
Plays for the New Orleans Pelicans
Dominant force in the paint
Known for his explosive dunks
37. Klay Thompson
One half of the "Splash Brothers"
Scored 37 points in a single quarter
Won 4 championships with the Warriors
Incredible 3-and-D player
Holds the record for most 3s in a game (14)
38. Draymond Green
The heart and soul of the Warriors dynasty
Known for his defense and playmaking
4-time NBA champion
Incredible basketball IQ and intensity
Defensive Player of the Year 2017
39. Ray Allen
One of the greatest shooters ever
Hit the famous corner 3 in 2013 Finals
Won titles with Celtics and Heat
Held the 3-point record before Curry
Known for his perfect shooting form
40. Reggie Miller
"Miller Time"
Indiana Pacers legend
Incredible clutch shooter and trash talker
Famous for scoring 8 points in 9 seconds
One of the best shooters in history
41. Carmelo Anthony
One of the best pure scorers ever
New York Knicks and Denver Nuggets icon
Famous for his mid-range game
Won 3 Olympic Gold medals
Top 10 all-time in scoring
42. Tracy McGrady
"T-Mac"
Scored 13 points in 33 seconds
Incredible scoring ability and athleticism
Won two scoring titles
One of the best "what if" careers due to injury
43. Vince Carter
"Half Man, Half Amazing" or "Vinsanity"
Greatest dunker in history
Played a record 22 seasons
Famous for the 2000 Slam Dunk Contest
Raptors and Nets legend
44. Scottie Pippen
The ultimate wingman to Michael Jordan
6-time NBA champion
One of the best perimeter defenders ever
Incredible versatility and IQ
Chicago Bulls legend
45. Isiah Thomas
Leader of the "Bad Boy" Pistons
2-time NBA champion
Incredible small guard with tough mentality
Beat Jordan, Bird, and Magic in their primes
Detroit Pistons icon
46. John Stockton
All-time leader in assists and steals
Played his entire career for the Utah Jazz
Famous for his pick-and-roll with Karl Malone
Never missed the playoffs in 19 seasons
The ultimate traditional point guard
47. Karl Malone
"The Mailman"
Second all-time in scoring for a long time
2-time NBA MVP
Utah Jazz legend
Incredible physical strength and longevity
48. Charles Barkley
"Sir Charles" or "The Round Mound of Rebound"
1993 NBA MVP
One of the best players never to win a title
Larger-than-life personality and commentator
Incredible rebounder for his size
49. David Robinson
"The Admiral"
2-time NBA champion with the Spurs
1995 NBA MVP
Served in the US Navy before the NBA
Once scored 71 points in a game
50. Manu Ginobili
Revolutionized the "Euro Step"
4-time NBA champion with the Spurs
Best sixth man in history
Led Argentina to Olympic Gold in 2004
Incredible creativity and fearlessness
`;

let PLAYERS = [];
const parsePlayers = (txt, type) => {
    const lines = txt.split(/\r?\n/);
    const entries = [];
    let current = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\.\s+(.*)$/);
        if (m) {
            const name = m[2].trim();
            if (current) entries.push(current);
            current = { name, hints: [], type };
            continue;
        }
        if (current) current.hints.push(line);
    }
    if (current) entries.push(current);
    return entries.map(e => ({ name: e.name, hints: e.hints.slice(0, 5), type: e.type }));
};

const loadPlayers = () => {
    PLAYERS = [
        ...parsePlayers(PLAYERS_CHESS_TEXT, 'chess'),
        ...parsePlayers(PLAYERS_FOOTBALL_TEXT, 'football'),
        ...parsePlayers(PLAYERS_BASKETBALL_TEXT, 'basketball')
    ];
};
loadPlayers();

// ---------------------------
// Register commands
// ---------------------------
client.once(Events.ClientReady, async () => {
    try {
        await client.application.commands.set([
            { name: 'daily', description: 'Claim your daily 25 coins' },
            { name: 'balance', description: 'Check coins', options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: false }] },
            { name: 'leaderboard', description: 'Top 10 players', options: [{ name: 'scope', description: 'Leaderboard scope', type: ApplicationCommandOptionType.String, required: false, choices: [{ name: 'Global', value: 'global' }, { name: 'Server', value: 'server' }] }] },
            { name: 'shop', description: 'View server shop' },
            { 
                name: 'item', 
                description: 'Manage shop items',
                default_member_permissions: (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString(),
                options: [
                    {
                        name: 'create',
                        description: 'Create a new shop item',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Item name', type: ApplicationCommandOptionType.String, required: true },
                            { name: 'role', description: 'Role to assign', type: ApplicationCommandOptionType.Role, required: true },
                            { name: 'price', description: 'Price in coins', type: ApplicationCommandOptionType.Integer, required: true }
                        ]
                    },
                    {
                        name: 'edit',
                        description: 'Edit an existing shop item (Admins only)',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'The current name of the item to edit', type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
                            { name: 'new_name', description: 'New name for the item', type: ApplicationCommandOptionType.String, required: false },
                            { name: 'price', description: 'New price for the item', type: ApplicationCommandOptionType.Integer, required: false },
                            { name: 'role', description: 'New role for the item', type: ApplicationCommandOptionType.Role, required: false }
                        ]
                    },
                    {
                        name: 'delete',
                        description: 'Delete an item or the entire shop (Admins only)',
                        type: ApplicationCommandOptionType.Subcommand,
                        options: [
                            { name: 'name', description: 'Item name to delete, or type "all" to clear the shop', type: ApplicationCommandOptionType.String, required: true, autocomplete: true }
                        ]
                    }
                ]
            },
            {
                name: 'shop-delete-all',
                description: 'Delete all items from the server shop (Admins only)',
                default_member_permissions: (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString()
            },
            { 
                name: 'quiz', 
                description: 'Get a question (5m cooldown)',
                options: [
                    {
                        name: 'type',
                        description: 'Category of the quiz',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Chess', value: 'chess' },
                            { name: 'Football', value: 'football' },
                            { name: 'Basketball', value: 'basketball' },
                            { name: 'Boxing', value: 'boxing' },
                            { name: 'YouTube', value: 'youtube' }
                        ]
                    }
                ]
            },
            { name: 'answer', description: 'Answer the quiz', options: [{ name: 'text', description: 'Your answer', type: ApplicationCommandOptionType.String, required: true }] },
            { 
                name: 'guesstheplayer', 
                description: 'Start Guess the Player (10m cooldown, hints cost 5 coins)',
                options: [
                    {
                        name: 'type',
                        description: 'Category of the player',
                        type: ApplicationCommandOptionType.String,
                        required: true,
                        choices: [
                            { name: 'Football', value: 'football' },
                            { name: 'Chess', value: 'chess' },
                            { name: 'Basketball', value: 'basketball' }
                        ]
                    }
                ]
            },
            { name: 'guess', description: 'Submit your player guess', options: [{ name: 'name', description: 'Player name', type: ApplicationCommandOptionType.String, required: true }] },
            { name: 'ration', description: 'Show your quiz stats' },
            { name: 'questions', description: 'Admin: View quiz questions', default_member_permissions: (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString(), options: [{ name: 'page', description: 'Page number (1-15)', type: ApplicationCommandOptionType.Integer, required: false }] },
            { name: 'addmoney', description: 'Admin: Add coins', default_member_permissions: (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString(), options: [{ name: 'user', description: 'User to give coins', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount of coins to add', type: ApplicationCommandOptionType.Integer, required: true }] },
            { name: 'removemoney', description: 'Admin: Remove coins', default_member_permissions: (PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles).toString(), options: [{ name: 'user', description: 'User to remove coins', type: ApplicationCommandOptionType.User, required: true }, { name: 'amount', description: 'Amount of coins to remove', type: ApplicationCommandOptionType.Integer, required: true }] }
        ]);
        console.log(`✅ Logged in as ${client.user.tag}`);
    } catch (err) {
        console.error("Command Registration Error:", err);
    }
});

// ---------------------------
// Quiz logic
// ---------------------------
async function getRandomQuizForUser(userId, type) {
    const history = await getQuizHistory(userId);
    const filteredPool = QUIZ_POOL.filter(q => q.type === type);
    const remaining = filteredPool.filter(q => !history.includes(q.id));
    
    if (remaining.length === 0) {
        // If all questions of this type were asked, clear history for this type only? 
        // Actually, the current logic clears ALL history. Let's stick to that but only for the specific type pool.
        // Or better, just pick a random one from the filtered pool.
        return filteredPool[Math.floor(Math.random() * filteredPool.length)];
    }
    return remaining[Math.floor(Math.random() * remaining.length)];
}

// ---------------------------
// Interaction Handler
// ---------------------------
client.on(Events.InteractionCreate, async interaction => {
    // 1. Immediate Deferral to prevent "Application didn't respond"
    try {
        if (interaction.isAutocomplete()) {
            const focusedValue = interaction.options.getFocused();
            const shopItems = await dbAll('SELECT itemName FROM server_shop WHERE guildId = ?', [interaction.guild.id]);
            const filtered = shopItems
                .filter(item => item.itemName.toLowerCase().includes(focusedValue.toLowerCase()))
                .map(item => ({ name: item.itemName, value: item.itemName }));
            
            // Limit to 25 choices (Discord limit)
            await interaction.respond(filtered.slice(0, 25)).catch(() => {});
            return;
        }

        if (interaction.isButton()) {
            await interaction.deferUpdate().catch(() => {});
        } else if (interaction.isChatInputCommand()) {
            await interaction.deferReply().catch(() => {});
        } else {
            return;
        }
    } catch (e) {
        console.error("Deferral Error:", e);
        return;
    }

    const { user, guild } = interaction;

    // 2. Background Tasks (Non-blocking)
    if (guild) {
        upsertGuildUser(guild.id, user.id).catch(() => {});
    }

    try {
        if (interaction.isButton()) {
            const { customId } = interaction;
            if (customId === 'shop_close') {
                await interaction.editReply({ components: [] });
                return;
            }
            if (customId === 'guess_next') {
                const active = await getGuessActive(user.id);
                if (!active) { await interaction.followUp({ content: "No active Guess the Player.", ephemeral: true }); return; }
                const entry = PLAYERS.find(p => p.name === active.playerName);
                if (!entry) { await interaction.followUp({ content: "This guess is no longer valid.", ephemeral: true }); return; }
                
                // Hint cost: 5 coins for hints after the first one
                const HINT_COST = 5;
                const data = await getServerUserData(guild.id, user.id);
                if (data.coins < HINT_COST) {
                    await interaction.followUp({ content: `❌ You need **${HINT_COST} coins** to reveal another hint!`, ephemeral: true });
                    return;
                }

                await addUserCoins(user.id, -HINT_COST, guild.id);
                const newData = await getServerUserData(guild.id, user.id);

                let idx = active.hintIndex + 1;
                if (idx > entry.hints.length) idx = entry.hints.length;
                await setGuessHintIndex(user.id, idx);
                
                const shown = entry.hints.slice(0, idx).map((h, i) => `Hint ${i+1}: ${h}`).join('\n');
                const embed = new EmbedBuilder()
                    .setTitle("🕵️ Guess the Player")
                    .setDescription(shown)
                    .setColor(0x8E44AD)
                    .setFooter({ text: `Balance: ${newData.coins} coins • Next hint: 5 coins` });

                const label = idx >= entry.hints.length ? 'No more hints' : `Next Hint (5 Coins)`;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('guess_next')
                        .setLabel(label)
                        .setStyle(idx >= entry.hints.length ? ButtonStyle.Secondary : ButtonStyle.Primary)
                        .setDisabled(idx >= entry.hints.length)
                );
                await interaction.editReply({ embeds: [embed], components: [row] });
                return;
            }
            if (customId.startsWith('shop_buy:')) {
                const itemName = customId.split(':')[1];
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ?', [guild.id]);
                const item = shopItems.find(s => s.itemName === itemName);
                if (!item) { await interaction.followUp({ content: "Item no longer exists in the shop.", ephemeral: true }); return; }
                
                const member = await guild.members.fetch(user.id);
                const role = guild.roles.cache.get(item.roleId);
                if (!role) { await interaction.followUp({ content: `The role associated with this item no longer exists.`, ephemeral: true }); return; }
                if (member.roles.cache.has(role.id)) { await interaction.followUp({ content: "You already own this role.", ephemeral: true }); return; }
                
                const data = await getServerUserData(guild.id, user.id);
                if (data.coins < item.price) { await interaction.followUp({ content: "Insufficient funds in this server to buy this item.", ephemeral: true }); return; }
                
                await member.roles.add(role.id);
                await addUserCoins(user.id, -item.price, guild.id);
                
                const newMember = await guild.members.fetch(user.id);
                const newData = await getServerUserData(guild.id, user.id);
                
                const fields = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const roleMention = sRole ? `<@&${sRole.id}>` : `Unknown Role`;
                    const ownedTxt = owned ? "Already Owned" : "Not Owned";
                    return { name: `♟️ ${s.itemName}`, value: `💰 Price: ${s.price} coins\n🎭 Role: ${roleMention}\n✅ Status: ${ownedTxt}`, inline: false };
                });
                
                const embed = new EmbedBuilder().setTitle(`🛒 Server Shop • Balance: ${newData.coins} coins`).addFields(fields).setColor(0x3498DB);
                const buttons = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? newMember.roles.cache.has(sRole.id) : false;
                    const label = owned ? `Owned: ${s.itemName}` : `Buy ${s.itemName} • ${s.price} Coins`;
                    return new ButtonBuilder().setCustomId(`shop_buy:${s.itemName}`).setLabel(label).setEmoji('🛒').setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary).setDisabled(owned);
                });
                
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }
                rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('shop_close').setLabel('Close Shop').setEmoji('🧹').setStyle(ButtonStyle.Danger)));
                
                await interaction.editReply({ embeds: [embed], components: rows });
                
                const successEmbed = new EmbedBuilder()
                    .setAuthor({ name: "🎉 Acquisition Successful" })
                    .setTitle("Item Purchased")
                    .setDescription(`You have successfully acquired the **${item.itemName}** role!`)
                    .addFields(
                        { name: '💰 Price Paid', value: `\`${item.price}\` coins`, inline: true },
                        { name: '🎭 New Rank', value: `<@&${role.id}>`, inline: true }
                    )
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3144/3144456.png')
                    .setTimestamp();

                await interaction.followUp({ embeds: [successEmbed], ephemeral: true });
                return;
            }
            return;
        }

        if (interaction.isChatInputCommand()) {
            const { commandName, options } = interaction;

            if (commandName === 'shop-delete-all') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can clear the shop.", ephemeral: true });
                }
                await new Promise((res, rej) => {
                    db.run('DELETE FROM server_shop WHERE guildId = ?', [guild.id], e => e ? rej(e) : res());
                });
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🧹 Shop Maintenance" })
                    .setTitle("Boutique Cleared")
                    .setDescription("All items have been successfully removed from the server shop.")
                    .setColor(0xE67E22)
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'quiz') {
                const type = options.getString('type');
                const active = await getActiveQuestion(user.id);
                const timeLimitMs = 60 * 1000;
                if (active) {
                    const elapsed = Date.now() - active.askedAt;
                    if (elapsed > timeLimitMs) {
                        await incQuizStat(user.id, 'wrong');
                        await clearActiveQuestion(user.id);
                        await setCooldown(user.id);
                        await addQuizToHistory(user.id, active.quizId);
                    } else {
                        const remaining = Math.ceil((timeLimitMs - elapsed) / 1000);
                        return interaction.editReply(`❗ Answer your current question first! Time left: ${remaining}s`);
                    }
                }
                const row = await getCooldown(user.id);
                const cooldownTime = 5 * 60 * 1000;
                if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                    const diff = cooldownTime - (Date.now() - row.lastUsed);
                    const h = Math.floor(diff / 3600000);
                    const m = Math.floor((diff % 3600000) / 60000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Cooldown Active")
                        .setDescription(`Try again in **${h}h ${m}m**.`)
                        .setColor(0x95A5A6);
                    return interaction.editReply({ embeds: [embed] });
                }
                
                // Filter quiz pool by selected type
                const filteredPool = QUIZ_POOL.filter(q => q.type === type);
                if (filteredPool.length === 0) {
                    return interaction.editReply(`❌ No questions available for category: **${type}**`);
                }

                const history = await getQuizHistory(user.id);
                const remaining = filteredPool.filter(q => !history.includes(q.id));
                let q;
                if (remaining.length === 0) {
                    // Reset history for this category if all used
                    await new Promise(res => db.run('DELETE FROM quiz_history WHERE userId = ?', [user.id], res));
                    q = filteredPool[Math.floor(Math.random() * filteredPool.length)];
                } else {
                    q = remaining[Math.floor(Math.random() * remaining.length)];
                }

                await setActiveQuestion(user.id, q.id);
                const embed = new EmbedBuilder()
                    .setAuthor({ name: `🧠 ${type.charAt(0).toUpperCase() + type.slice(1)} Challenge`, iconURL: 'https://cdn-icons-png.flaticon.com/512/3565/3565418.png' })
                    .setTitle("Knowledge Test")
                    .setDescription(`**Question:**\n${q.question}\n\n⏱️ **Time Limit:** \`60 seconds\`\n📝 **How to answer:** Use \`/answer\``)
                    .setColor(0x2ECC71)
                    .addFields({ name: '💰 Potential Reward', value: `\`${q.reward}\` coins`, inline: true })
                    .setFooter({ text: `Good luck, ${user.username}!` })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'guesstheplayer') {
                const type = options.getString('type');
                const row = await getGuessCooldown(user.id);
                const cooldownTime = 10 * 60 * 1000;
                if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                    const diff = cooldownTime - (Date.now() - row.lastUsed);
                    const m = Math.floor(diff / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    return interaction.editReply(`⏳ Cooldown! Try again in ${m}m ${s}s.`);
                }
                
                const filteredPlayers = PLAYERS.filter(p => p.type === type);
                if (filteredPlayers.length === 0) {
                    return interaction.editReply(`❌ No players available for category: **${type}**`);
                }

                const p = filteredPlayers[Math.floor(Math.random() * filteredPlayers.length)];
                await setGuessActive(user.id, p.name);
                await setGuessCooldown(user.id);

                const embed = new EmbedBuilder()
                    .setTitle(`🕵️ Guess the ${type.charAt(0).toUpperCase() + type.slice(1)} Player`)
                    .setDescription(`Hint 1: ${p.hints[0]}`)
                    .setColor(0x8E44AD)
                    .setFooter({ text: "Use /guess to answer • Hints cost 5 coins" });

                const rowBtn = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('guess_next').setLabel('Next Hint (5 Coins)').setStyle(ButtonStyle.Primary)
                );
                return interaction.editReply({ embeds: [embed], components: [rowBtn] });
            }

            if (commandName === 'answer') {
                const active = await getActiveQuestion(user.id);
                if (!active) {
                    const embed = new EmbedBuilder()
                        .setTitle("❌ No Active Quiz")
                        .setDescription("You don't have an active question to answer. Start one with `/quiz`!")
                        .setColor(0xE74C3C);
                    return interaction.editReply({ embeds: [embed] });
                }
                
                const q = QUIZ_POOL.find(i => i.id === active.quizId);
                const input = options.getString('text');
                const timeLimitMs = 60 * 1000;
                const timedOut = (Date.now() - active.askedAt) > timeLimitMs;
                const correct = isAnswerMatch(input, q);
                
                await clearActiveQuestion(user.id);
                await setCooldown(user.id);
                await addQuizToHistory(user.id, q.id);

                if (!timedOut && correct) {
                    await incQuizStat(user.id, 'correct');
                    await addUserCoins(user.id, q.reward, guild.id);
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "✅ Tactical Success" })
                        .setTitle("Brilliant Move!")
                        .setDescription(`You found the correct solution: **${q.answer}**`)
                        .addFields({ name: '💰 Reward Earned', value: `\`${q.reward}\` coins`, inline: true })
                        .setColor(0x2ECC71)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/190/190411.png')
                        .setFooter({ text: "Keep it up!" });
                    return interaction.editReply({ embeds: [embed] });
                }
                await incQuizStat(user.id, 'wrong');
                const embed = timedOut
                    ? new EmbedBuilder()
                        .setAuthor({ name: "⏱️ Clock Flagged" })
                        .setTitle("Time is up!")
                        .setDescription(`You were too slow. The correct answer was: **${q.answer}**`)
                        .setColor(0xE67E22)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/3232/3232873.png')
                    : new EmbedBuilder()
                        .setAuthor({ name: "❌ Blunder" })
                        .setTitle("Incorrect Solution")
                        .setDescription(`That wasn't quite right. The correct answer was: **${q.answer}**`)
                        .setColor(0xE74C3C)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/1156/1156641.png');
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'daily') {
                const data = await getUserData(user.id);
                if (Date.now() - data.lastDaily < 86400000) {
                    const remaining = 86400000 - (Date.now() - data.lastDaily);
                    const h = Math.floor(remaining / 3600000);
                    const m = Math.floor((remaining % 3600000) / 60000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Patience, Grandmaster")
                        .setDescription(`You've already claimed your daily reward. Come back in **${h}h ${m}m**.`)
                        .setColor(0x95A5A6);
                    return interaction.editReply({ embeds: [embed] });
                }
                await addUserCoins(user.id, 25, guild.id);
                db.run('UPDATE users SET lastDaily = ? WHERE userId = ?', [Date.now(), user.id]);
                const embed = new EmbedBuilder()
                    .setTitle("🎁 Daily Allowance")
                    .setDescription("Your daily stipend has been deposited into your treasury.")
                    .addFields({ name: '💰 Amount', value: '`25` coins', inline: true })
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1162/1162951.png')
                    .setFooter({ text: "Come back tomorrow for more!" });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'balance') {
                const target = options.getUser('user') || user;
                const data = await getServerUserData(guild.id, target.id);
                const embed = new EmbedBuilder()
                    .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL({ dynamic: true }) })
                    .setTitle("💰 Treasury Report")
                    .setDescription(`**${target.username}** currently holds:`)
                    .addFields(
                        { name: '🪙 Server Coins', value: `\`${data.coins.toLocaleString()}\``, inline: true }
                    )
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/272/272525.png')
                    .setColor(0xF1C40F)
                    .setFooter({ text: `Requested by ${user.tag}`, iconURL: user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'leaderboard') {
                const scope = options.getString('scope') || 'server';
                let rows;
                if (scope === 'server' && guild) {
                    rows = await dbAll(
                        'SELECT userId, coins FROM server_coins WHERE guildId = ? ORDER BY coins DESC LIMIT 10',
                        [guild.id]
                    );
                } else {
                    rows = await dbAll('SELECT userId, coins FROM users ORDER BY coins DESC LIMIT 10');
                }
                const medals = ['🥇','🥈','🥉'];
                const txt = rows.map((r, i) => {
                    const medal = medals[i] || `**#${i+1}**`;
                    return `${medal} <@${r.userId}> \u2014 \`${r.coins.toLocaleString()}\` coins`;
                }).join('\n') || "*The records are currently empty.*";
                
                const title = scope === 'server' ? "🏆 Server Power Rankings" : "🌍 Global Hall of Fame";
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📊 Competitive Standings" })
                    .setTitle(title)
                    .setDescription(`The top 10 strategists currently dominating the boards.\n\n${txt}`)
                    .setThumbnail(scope === 'server' ? guild.iconURL({ dynamic: true }) : 'https://cdn-icons-png.flaticon.com/512/1021/1021204.png')
                    .setColor(0xFFD700)
                    .setFooter({ text: `Scope: ${scope.charAt(0).toUpperCase() + scope.slice(1)} • Updated just now` })
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'guesstheplayer') {
                if (!PLAYERS.length) return interaction.editReply("❌ Player list is unavailable.");
                const row = await getGuessCooldown(user.id);
                const cooldownTime = 10 * 60 * 1000;
                if (row && (Date.now() - row.lastUsed < cooldownTime)) {
                    const diff = cooldownTime - (Date.now() - row.lastUsed);
                    const m = Math.floor(diff / 60000);
                    const s = Math.floor((diff % 60000) / 1000);
                    const embed = new EmbedBuilder()
                        .setTitle("⏳ Recharge Required")
                        .setDescription(`Your tactical vision is recharging. Try again in **${m}m ${s}s**.`)
                        .setColor(0xE74C3C)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/2088/2088617.png');
                    return interaction.editReply({ embeds: [embed] });
                }
                const data = await getServerUserData(guild.id, user.id);
                const active = await getGuessActive(user.id);
                if (active) {
                    const entry = PLAYERS.find(p => p.name === active.playerName);
                    const idx = Math.max(1, active.hintIndex);
                    const shown = entry ? entry.hints.slice(0, idx).map((h, i) => `**Hint ${i+1}:** ${h}`).join('\n') : "No hints available.";
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🕵️ Intelligence Report" })
                        .setTitle("Guess the Grandmaster")
                        .setDescription(shown)
                        .setColor(0x8E44AD)
                        .addFields({ name: '💰 Cost', value: 'Next hint: `5 coins`', inline: true }, { name: '🪙 Balance', value: `\`${data.coins}\` coins`, inline: true })
                        .setFooter({ text: "Use /guess to submit your answer" });
                    
                    const label = idx >= entry.hints.length ? 'All Intel Gathered' : `Next Hint (5 Coins)`;
                    const rowComp = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('guess_next')
                            .setLabel(label)
                            .setStyle(idx >= entry.hints.length ? ButtonStyle.Secondary : ButtonStyle.Primary)
                            .setDisabled(idx >= entry.hints.length)
                    );
                    return interaction.editReply({ embeds: [embed], components: [rowComp] });
                }
                const entry = PLAYERS[Math.floor(Math.random() * PLAYERS.length)];
                await setGuessActive(user.id, entry.name);
                const first = entry.hints[0] || "No hint.";
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🕵️ Intelligence Report" })
                    .setTitle("Guess the Grandmaster")
                    .setDescription(`**Hint 1:** ${first}`)
                    .setColor(0x9B59B6)
                    .addFields({ name: '💰 Cost', value: 'Next hint: `5 coins`', inline: true }, { name: '🪙 Balance', value: `\`${data.coins}\` coins`, inline: true })
                    .setFooter({ text: "First hint is free! Use /guess to answer." });

                const rowComp = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('guess_next')
                        .setLabel('Next Hint (5 Coins)')
                        .setStyle(ButtonStyle.Primary)
                );
                return interaction.editReply({ embeds: [embed], components: [rowComp] });
            }

            if (commandName === 'guess') {
                const active = await getGuessActive(user.id);
                if (!active) {
                    const embed = new EmbedBuilder()
                        .setTitle("❌ No Active Intelligence Mission")
                        .setDescription("You aren't currently tracking any players. Start a mission with `/guesstheplayer`!")
                        .setColor(0xE74C3C);
                    return interaction.editReply({ embeds: [embed] });
                }
                const nameInput = options.getString('name');
                const correct = isNameMatch(nameInput, active.playerName);
                
                await clearGuessActive(user.id);
                await setGuessCooldown(user.id);

                if (correct) {
                    await addUserCoins(user.id, 10, guild.id);
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🎯 Mission Accomplished" })
                        .setTitle("Target Identified!")
                        .setDescription(`Brilliant deduction! The player was indeed **${active.playerName}**.`)
                        .addFields({ name: '💰 Intelligence Bounty', value: '`10` coins', inline: true })
                        .setColor(0x2ECC71)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/190/190411.png')
                        .setFooter({ text: "Your tactical intuition is sharp." });
                    return interaction.editReply({ embeds: [embed], components: [] });
                }
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "❌ Mission Failed" })
                    .setTitle("Identity Mismatch")
                    .setDescription(`Your intelligence was incorrect. The player has escaped.`)
                    .addFields({ name: '👤 Actual Identity', value: `||${active.playerName}||`, inline: true })
                    .setColor(0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1156/1156641.png')
                    .setFooter({ text: "Wait for the cooldown to start a new mission." });
                return interaction.editReply({ embeds: [embed], components: [] });
            }
            if (commandName === 'questions') {
                const isAdmin = guild && (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles));
                if (!isAdmin) return interaction.editReply("❌ Admins or users with Manage Roles only.");
                const pageSize = 20;
                const total = QUIZ_POOL.length;
                const totalPages = Math.ceil(total / pageSize);
                let page = options.getInteger('page') || 1;
                if (page < 1) page = 1;
                if (page > totalPages) page = totalPages;
                const start = (page - 1) * pageSize;
                const slice = QUIZ_POOL.slice(start, start + pageSize);
                const lines = slice.map(q => `**#${q.id}:** ${q.question}`);
                const txt2 = lines.join('\n') || "*No questions found.*";

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📚 Question Repository" })
                    .setTitle(`Page ${page} of ${totalPages}`)
                    .setDescription(txt2)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3407/3407024.png')
                    .setFooter({ text: `Admin Access Only • Total Questions: ${total}` });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'ration') {
                const stats = await getQuizStats(user.id);
                const total = stats.correct + stats.wrong;
                const ratio = total > 0 ? ((stats.correct / total) * 100).toFixed(1) : 0;

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "📊 Tactical Performance Record" })
                    .setTitle(`${user.username}'s Statistics`)
                    .setDescription(`Detailed analysis of your chess training sessions.`)
                    .addFields(
                        { name: '✅ Correct Solutions', value: `\`${stats.correct}\``, inline: true },
                        { name: '❌ Failed Puzzles', value: `\`${stats.wrong}\``, inline: true },
                        { name: '📈 Success Rate', value: `\`${ratio}%\``, inline: true }
                    )
                    .setColor(ratio >= 50 ? 0x2ECC71 : 0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/1611/1611174.png')
                    .setFooter({ text: "Keep practicing to improve your accuracy!" });
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'shop') {
                const shopItems = await dbAll('SELECT * FROM server_shop WHERE guildId = ? ORDER BY price ASC', [guild.id]);
                if (shopItems.length === 0) {
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛒 Grandmaster's Boutique" })
                        .setTitle("Shop is Currently Closed")
                        .setDescription("The local merchants haven't set up shop here yet. Check back later!")
                        .setColor(0xE74C3C)
                        .setThumbnail('https://cdn-icons-png.flaticon.com/512/1041/1041916.png');
                    return interaction.editReply({ embeds: [embed], ephemeral: true });
                }

                const member = await guild.members.fetch(user.id);
                const data = await getServerUserData(guild.id, user.id);
                const fields = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? member.roles.cache.has(sRole.id) : false;
                    const roleMention = sRole ? `<@&${sRole.id}>` : `Unknown Role`;
                    const status = owned ? "✅ **Already Owned**" : "🛒 **Available**";
                    return {
                        name: `♟️ ${s.itemName}`,
                        value: `💰 **Price:** \`${s.price}\` coins\n🎭 **Role:** ${roleMention}\n✨ **Status:** ${status}`,
                        inline: false
                    };
                });
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "🛒 Grandmaster's Boutique", iconURL: guild.iconURL({ dynamic: true }) })
                    .setTitle("Server Exclusive Items")
                    .setDescription(`Welcome to the marketplace! You currently have \`${data.coins}\` coins to spend.`)
                    .addFields(fields)
                    .setColor(0x3498DB)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/3081/3081559.png')
                    .setFooter({ text: `Browse at your leisure • ${guild.name}` });

                const buttons = shopItems.map(s => {
                    const sRole = guild.roles.cache.get(s.roleId);
                    const owned = sRole ? member.roles.cache.has(sRole.id) : false;
                    const label = owned ? `Owned` : `${s.price} Coins`;
                    return new ButtonBuilder()
                        .setCustomId(`shop_buy:${s.itemName}`)
                        .setLabel(label)
                        .setEmoji(owned ? '✅' : '🛒')
                        .setStyle(owned ? ButtonStyle.Secondary : ButtonStyle.Primary)
                        .setDisabled(owned);
                });
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
                }
                rows.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('shop_close').setLabel('Leave Shop').setEmoji('🚪').setStyle(ButtonStyle.Danger)
                ));
                return interaction.editReply({ embeds: [embed], components: rows });
            }

            if (commandName === 'item') {
                const sub = options.getSubcommand();
                if (sub === 'create') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can create shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    const role = options.getRole('role');
                    const price = options.getInteger('price');

                    const countResult = await dbAll('SELECT COUNT(*) as c FROM server_shop WHERE guildId = ?', [guild.id]);
                    const count = countResult[0].c;
                    if (count >= 10) {
                        const embed = new EmbedBuilder()
                            .setTitle("🚫 Inventory Full")
                            .setDescription("Your shop has reached the maximum capacity of **10 items**. Delete an item to make room for more.")
                            .setColor(0xE74C3C);
                        return interaction.editReply({ embeds: [embed], ephemeral: true });
                    }

                    await new Promise((res, rej) => {
                        db.run('INSERT OR REPLACE INTO server_shop (guildId, itemName, roleId, price) VALUES (?, ?, ?, ?)', [guild.id, name, role.id, price], e => e ? rej(e) : res());
                    });

                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛠️ Merchant Tools" })
                        .setTitle("Item Created Successfully")
                        .setDescription(`A new item has been added to the boutique.`)
                        .addFields(
                            { name: '📦 Item Name', value: `\`${name}\``, inline: true },
                            { name: '💰 Price', value: `\`${price}\` coins`, inline: true },
                            { name: '🎭 Role', value: `<@&${role.id}>`, inline: true }
                        )
                        .setColor(0x2ECC71)
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                if (sub === 'edit') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can edit shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    const newName = options.getString('new_name');
                    const newPrice = options.getInteger('price');
                    const newRole = options.getRole('role');

                    const item = (await dbAll('SELECT * FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, name]))[0];
                    if (!item) {
                        const embed = new EmbedBuilder()
                            .setTitle("❌ Item Not Found")
                            .setDescription(`The item **${name}** does not exist in your shop.`)
                            .setColor(0xE74C3C);
                        return interaction.editReply({ embeds: [embed], ephemeral: true });
                    }

                    if (newName) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET itemName = ? WHERE guildId = ? AND itemName = ?', [newName, guild.id, name], e => e ? rej(e) : res());
                        });
                    }
                    
                    const currentName = newName || name;
                    
                    if (newPrice !== null) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET price = ? WHERE guildId = ? AND itemName = ?', [newPrice, guild.id, currentName], e => e ? rej(e) : res());
                        });
                    }
                    
                    if (newRole) {
                        await new Promise((res, rej) => {
                            db.run('UPDATE server_shop SET roleId = ? WHERE guildId = ? AND itemName = ?', [newRole.id, guild.id, currentName], e => e ? rej(e) : res());
                        });
                    }
                    
                    const embed = new EmbedBuilder()
                        .setAuthor({ name: "🛠️ Merchant Tools" })
                        .setTitle("Item Updated")
                        .setDescription(`Modifications to **${name}** have been finalized.`)
                        .setColor(0x3498DB)
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }

                if (sub === 'delete') {
                    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                        return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can delete shop items.", ephemeral: true });
                    }
                    const name = options.getString('name');
                    if (name.toLowerCase() === 'all') {
                        await new Promise((res, rej) => {
                            db.run('DELETE FROM server_shop WHERE guildId = ?', [guild.id], e => e ? rej(e) : res());
                        });
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🛠️ Merchant Tools" })
                            .setTitle("Shop Cleared")
                            .setDescription("All items have been removed from the boutique.")
                            .setColor(0xE67E22);
                        return interaction.editReply({ embeds: [embed] });
                    } else {
                        const result = await new Promise((res, rej) => {
                            db.run('DELETE FROM server_shop WHERE guildId = ? AND itemName = ?', [guild.id, name], function(e) {
                                if (e) rej(e);
                                else res(this.changes);
                            });
                        });
                        if (result === 0) {
                            const embed = new EmbedBuilder()
                                .setTitle("❌ Item Not Found")
                                .setDescription(`The item **${name}** does not exist in your shop.`)
                                .setColor(0xE74C3C);
                            return interaction.editReply({ embeds: [embed], ephemeral: true });
                        }
                        const embed = new EmbedBuilder()
                            .setAuthor({ name: "🛠️ Merchant Tools" })
                            .setTitle("Item Removed")
                            .setDescription(`The item **${name}** has been removed from the boutique.`)
                            .setColor(0xE67E22);
                        return interaction.editReply({ embeds: [embed] });
                    }
                }
            }

            if (commandName === 'addmoney') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury.", ephemeral: true });
                }
                const target = options.getUser('user');
                const amount = options.getInteger('amount');
                await addUserCoins(target.id, amount, guild.id);
                
                const embed = new EmbedBuilder()
                    .setAuthor({ name: "💸 Treasury Transaction" })
                    .setTitle("Funds Granted")
                    .setDescription(`An imperial grant of **${amount}** coins has been issued.`)
                    .addFields({ name: '👤 Recipient', value: `<@${target.id}>`, inline: true })
                    .setColor(0x2ECC71)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2454/2454282.png')
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (commandName === 'removemoney') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return interaction.editReply({ content: "❌ Only Administrators or users with Manage Roles can manage the treasury.", ephemeral: true });
                }
                const target = options.getUser('user');
                const amount = options.getInteger('amount');
                await addUserCoins(target.id, -amount, guild.id);

                const embed = new EmbedBuilder()
                    .setAuthor({ name: "💸 Treasury Transaction" })
                    .setTitle("Funds Revoked")
                    .setDescription(`A penalty of **${amount}** coins has been deducted.`)
                    .addFields({ name: '👤 Target', value: `<@${target.id}>`, inline: true })
                    .setColor(0xE74C3C)
                    .setThumbnail('https://cdn-icons-png.flaticon.com/512/2454/2454297.png')
                    .setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }
        }

    } catch (err) {
        console.error("Interaction Error:", err);
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply("⚠️ Error occurred while processing that command.").catch(() => {});
            } else {
                await interaction.reply({ content: "⚠️ Error occurred while processing that command.", ephemeral: true }).catch(() => {});
            }
        } catch (e) {}
    }
});
client.login(DISCORD_TOKEN);

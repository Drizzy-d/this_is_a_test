const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
// On Render, set DB_PATH=/var/data/choco_campus.db and attach a disk at /var/data.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'choco_campus.db');
const SESSION_COOKIE = 'choco_campus_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// Serve only public website assets. Do NOT serve the project root: that would
// make files such as the SQLite database and server source downloadable.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'choco-campus.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.use('/resource', express.static(path.join(__dirname, 'resource')));

const envWhatsApp = String(process.env.SELLER_WHATSAPP || '').replace(/\D/g, '');
const DEFAULT_STATE = {
    whatsapp: envWhatsApp,
    minPurchase: Number(process.env.MIN_PURCHASE) || 4,
    threshold: Number(process.env.LOYALTY_THRESHOLD) || 10,
    orders: [],
    customers: [],
    // Set ADMIN_PASSWORD in Render's Environment settings before deployment.
    adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
};

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Database error:', err.message);
        process.exit(1);
    }
    console.log('Choco Campus database connected.');
});

function run(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

async function readState() {
    const row = await get('SELECT value FROM app_data WHERE key = ?', ['state']);
    if (!row) return { ...DEFAULT_STATE };

    try {
        const saved = JSON.parse(row.value);
        const state = { ...DEFAULT_STATE, ...saved };
        // Seed blank legacy settings from Render environment variables. This
        // also fixes databases that were initialized before env defaults existed.
        if (!String(state.whatsapp || '').trim() && DEFAULT_STATE.whatsapp) {
            state.whatsapp = DEFAULT_STATE.whatsapp;
        }
        if ((!state.adminPassword || state.adminPassword === 'admin123') && process.env.ADMIN_PASSWORD) {
            state.adminPassword = process.env.ADMIN_PASSWORD;
        }
        return state;
    } catch {
        return { ...DEFAULT_STATE };
    }
}

async function saveState(state) {
    await run(
        `INSERT INTO app_data (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ['state', JSON.stringify(state)]
    );
}

function parseCookies(header = '') {
    const cookies = {};
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index < 0) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        cookies[key] = value;
    }
    return cookies;
}

function hasAdminSession(req) {
    const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (!token) return false;
    const session = adminSessions.get(token);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

function requireAdmin(req, res, next) {
    if (!hasAdminSession(req)) {
        return res.status(401).json({ error: 'Admin login required.' });
    }
    next();
}

function passwordsMatch(submitted, expected) {
    const a = Buffer.from(String(submitted));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicState(state, isAdmin) {
    const { adminPassword, ...safeState } = state;
    if (!isAdmin) {
        // Customer names, phone numbers, order history, and loyalty records
        // should not be downloaded by ordinary visitors.
        safeState.orders = [];
        safeState.customers = [];
    }
    return safeState;
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'choco-campus' });
});

app.get('/api/state', async (req, res) => {
    try {
        res.json(publicState(await readState(), hasAdminSession(req)));
    } catch (err) {
        console.error('Could not load state:', err.message);
        res.status(500).json({ error: 'Could not load data.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const state = await readState();
        const password = String(req.body?.password ?? '');
        if (!passwordsMatch(password, state.adminPassword || 'admin123')) {
            return res.status(401).json({ success: false, error: 'Mot de passe incorrect.' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        adminSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Login failed:', err.message);
        res.status(500).json({ success: false, error: 'Erreur de connexion au serveur.' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ success: true });
});

app.post('/api/settings', requireAdmin, async (req, res) => {
    try {
        const state = await readState();
        if (req.body?.whatsapp !== undefined) {
            state.whatsapp = String(req.body.whatsapp).replace(/\D/g, '');
        }
        for (const key of ['minPurchase', 'threshold']) {
            if (req.body?.[key] !== undefined) {
                const value = Number(req.body[key]);
                if (Number.isFinite(value) && value >= 1) state[key] = Math.floor(value);
            }
        }
        await saveState(state);
        res.json({ success: true });
    } catch (err) {
        console.error('Could not save settings:', err.message);
        res.status(500).json({ error: 'Could not save settings.' });
    }
});

app.post('/api/password', requireAdmin, async (req, res) => {
    try {
        const password = String(req.body?.newPassword ?? '');
        if (password.length < 10) {
            return res.status(400).json({
                success: false,
                error: 'Le mot de passe doit contenir au moins 10 caractères.'
            });
        }
        const state = await readState();
        state.adminPassword = password;
        await saveState(state);
        res.json({ success: true });
    } catch (err) {
        console.error('Could not save password:', err.message);
        res.status(500).json({ error: 'Could not save password.' });
    }
});

app.post('/api/orders', async (req, res) => {
    try {
        const order = req.body;
        if (!order || !order.id) {
            return res.status(400).json({ error: 'Order ID is required.' });
        }
        const state = await readState();
        if (!Array.isArray(state.orders)) state.orders = [];
        const index = state.orders.findIndex(item => String(item.id) === String(order.id));

        // Students may submit a new order, but only a logged-in admin may
        // update an existing order (e.g. mark it delivered).
        if (index >= 0 && !hasAdminSession(req)) {
            return res.status(401).json({ error: 'Admin login required to update an order.' });
        }
        if (index >= 0) state.orders[index] = { ...state.orders[index], ...order };
        else state.orders.unshift(order);

        await saveState(state);
        res.json({ success: true, order });
    } catch (err) {
        console.error('Could not save order:', err.message);
        res.status(500).json({ error: 'Could not save order.' });
    }
});

app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
    try {
        const state = await readState();
        const before = state.orders.length;
        state.orders = state.orders.filter(order => String(order.id) !== String(req.params.id));
        await saveState(state);
        res.json({ success: true, deleted: before - state.orders.length });
    } catch (err) {
        console.error('Could not delete order:', err.message);
        res.status(500).json({ error: 'Could not delete order.' });
    }
});

app.post('/api/customers', requireAdmin, async (req, res) => {
    try {
        const customer = req.body;
        if (!customer || !customer.id) {
            return res.status(400).json({ error: 'Customer ID is required.' });
        }
        const state = await readState();
        if (!Array.isArray(state.customers)) state.customers = [];
        const index = state.customers.findIndex(item => String(item.id) === String(customer.id));
        if (index >= 0) state.customers[index] = { ...state.customers[index], ...customer };
        else state.customers.push(customer);
        await saveState(state);
        res.json({ success: true, customer });
    } catch (err) {
        console.error('Could not save customer:', err.message);
        res.status(500).json({ error: 'Could not save customer.' });
    }
});

async function start() {
    try {
        await run(`CREATE TABLE IF NOT EXISTS app_data (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);
        const existing = await get('SELECT value FROM app_data WHERE key = ?', ['state']);
        if (!existing) await saveState(DEFAULT_STATE);
        app.listen(PORT, () => {
            console.log('Choco Campus server listening on port ' + PORT);
            console.log('Database path: ' + DB_PATH);
            console.log('Persistent database configured: ' + (Boolean(process.env.DB_PATH)));
            if (!DEFAULT_STATE.whatsapp) {
                console.warn('SELLER_WHATSAPP is empty; configure it in Render Environment or the admin dashboard.');
            }
            if (!process.env.ADMIN_PASSWORD) {
                console.warn('ADMIN_PASSWORD is not set; change the default admin password before using the public site.');
            }
        });
    } catch (err) {
        console.error('Server initialization failed:', err.message);
        process.exit(1);
    }
}

process.on('SIGINT', () => db.close(() => process.exit(0)));
process.on('SIGTERM', () => db.close(() => process.exit(0)));

start();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // שינוי: שימוש ב-pg במקום sqlite3

const app = express();
const PORT = process.env.PORT || 3000;

// מידלוור - CORS
app.use(cors({
    origin: function(origin, callback) {
        const allowedOrigins = [
            'https://remote.azriasolutions.com',
            'https://tablocker-mobile.vercel.app',
            'http://localhost:3000',
            'http://localhost:5000'
        ];
        if (!origin || allowedOrigins.includes(origin) || origin.startsWith('chrome-extension://')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// שינוי: אתחול מסד נתונים PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// פונקציה לבדיקת חיבור וליצירת טבלאות
async function initDatabase() {
    try {
        await pool.query('SELECT NOW()'); // בדוק חיבור
        console.log('Connected to PostgreSQL database');
        
        // יצירת טבלאות אם לא קיימות (תחביר של PostgreSQL)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                device_code TEXT NOT NULL UNIQUE,
                type TEXT DEFAULT 'chrome_extension',
                last_seen TIMESTAMPTZ,
                status TEXT DEFAULT 'online',
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS commands (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                device_code TEXT NOT NULL,
                command JSONB NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                executed_at TIMESTAMPTZ
            );
            CREATE TABLE IF NOT EXISTS responses (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                device_code TEXT NOT NULL,
                response_data JSONB,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('✅ All tables are ready');
    } catch (err) {
        console.error('Error initializing database:', err);
        process.exit(1); // צא אם אין חיבור למסד הנתונים
    }
}

initDatabase(); // קריאה לאתחול

// פונקציה לחילוץ קוד מכשיר
function extractDeviceCode(deviceId) {
    return deviceId.slice(-6).toUpperCase();
}

// ENDPOINTS - כולם שוכתבו לשימוש ב-pool.query עם תחביר PostgreSQL

// רישום מכשיר חדש
app.post('/api/register', async (req, res) => {
    const { deviceId, type = 'chrome_extension' } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID required' });

    const deviceCode = extractDeviceCode(deviceId);
    const query = `
        INSERT INTO devices (id, device_code, type, last_seen, status) 
        VALUES ($1, $2, $3, NOW(), 'online')
        ON CONFLICT (id) DO UPDATE SET 
            last_seen = NOW(), status = 'online', device_code = $2;
    `;
    
    try {
        await pool.query(query, [deviceId, deviceCode, type]);
        console.log(`✅ Device registered: ${deviceId} (code: ${deviceCode})`);
        res.json({ success: true, deviceId, deviceCode });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// חיפוש מכשיר לפי קוד
app.post('/api/find-device', async (req, res) => {
    const { deviceCode } = req.body;
    if (!deviceCode || !/^[A-F0-9]{6}$/.test(deviceCode.toUpperCase())) {
        return res.status(400).json({ error: 'Invalid device code', found: false });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM devices WHERE device_code = $1 AND status = $2',
            [deviceCode.toUpperCase(), 'online']
        );

        if (result.rows.length === 0) {
            return res.json({ found: false, error: 'Device not found or offline' });
        }
        
        const device = result.rows[0];
        await pool.query('UPDATE devices SET last_seen = NOW() WHERE id = $1', [device.id]);
        
        res.json({ found: true, device: {
            id: device.id,
            code: device.device_code,
            type: device.type,
        }});
    } catch (err) {
        console.error('Find device error:', err);
        res.status(500).json({ error: 'Database error', found: false });
    }
});

// שליחת פקודה למכשיר
app.post('/api/send-command', async (req, res) => {
    const { deviceCode, command } = req.body;
    if (!deviceCode || !command) return res.status(400).json({ error: 'Device code and command required' });

    try {
        const deviceRes = await pool.query('SELECT id FROM devices WHERE device_code = $1 AND status = $2', [deviceCode.toUpperCase(), 'online']);
        if (deviceRes.rows.length === 0) {
            return res.status(404).json({ error: 'Device not found or offline', success: false });
        }
        const deviceId = deviceRes.rows[0].id;
        
        const cmdRes = await pool.query(
            'INSERT INTO commands (device_id, device_code, command) VALUES ($1, $2, $3) RETURNING id',
            [deviceId, deviceCode.toUpperCase(), command]
        );
        
        console.log(`📤 Command queued for device ${deviceCode}: ${command.action}`);
        res.json({ success: true, commandId: cmdRes.rows[0].id });
    } catch (err) {
        console.error('Send command error:', err);
        res.status(500).json({ error: 'Failed to queue command', success: false });
    }
});


// קבלת פקודות עבור מכשיר (polling)
app.get('/api/commands/:deviceId', async (req, res) => {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'Device ID required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const commandsRes = await client.query(
            'SELECT id, command FROM commands WHERE device_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 10',
            [deviceId, 'pending']
        );
        const commands = commandsRes.rows;

        if (commands.length > 0) {
            const commandIds = commands.map(c => c.id);
            await client.query(
                'UPDATE commands SET status = $1, executed_at = NOW() WHERE id = ANY($2::int[])',
                ['completed', commandIds]
            );
        }
        
        await client.query('UPDATE devices SET last_seen = NOW(), status = $1 WHERE id = $2', ['online', deviceId]);
        
        await client.query('COMMIT');
        
        res.json(commands.map(cmd => cmd.command));

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Get commands error:', err);
        res.status(500).json({ error: 'Failed to get commands' });
    } finally {
        client.release();
    }
});


// קבלת תגובה ממכשיר
app.post('/api/response', async (req, res) => {
    const { deviceId, ...responseData } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'Device ID required' });

    try {
        const deviceCode = extractDeviceCode(deviceId);
        await pool.query(
            'INSERT INTO responses (device_id, device_code, response_data) VALUES ($1, $2, $3)',
            [deviceId, deviceCode, responseData]
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Save response error:', err);
        res.status(500).json({ error: 'Failed to save response' });
    }
});

// קבלת תגובות לפי קוד מכשיר (לאפליקציה)
app.get('/api/responses/:deviceCode', async (req, res) => {
    const { deviceCode } = req.params;
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const responsesRes = await client.query(
            `SELECT id, response_data, created_at FROM responses 
             WHERE device_code = $1 ORDER BY created_at DESC LIMIT 10`,
            [deviceCode.toUpperCase()]
        );
        const responses = responsesRes.rows;
        
        if (responses.length > 0) {
            const responseIds = responses.map(r => r.id);
            await client.query('DELETE FROM responses WHERE id = ANY($1::int[])', [responseIds]);
        }
        
        await client.query('COMMIT');
        res.json(responses.map(r => ({ ...r.response_data, timestamp: r.created_at })));

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Get responses error:', err);
        res.status(500).json({ error: 'Failed to get responses' });
    } finally {
        client.release();
    }
});


// Health check endpoint
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));


app.listen(PORT, () => {
    console.log(`🚀 Tab Locker API Server running on port ${PORT}`);
});
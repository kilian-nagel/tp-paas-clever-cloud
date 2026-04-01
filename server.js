require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const EventEmitter = require('events');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const alertEmitter = new EventEmitter();

const redisUrl = process.env.REDIS_ADDON_URI || 'redis://localhost:6379';
const pubClient = createClient({ url: redisUrl });
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => console.error('Redis Pub Client Error', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error', err));

(async () => {
    await pubClient.connect();
    await subClient.connect();
    
    await subClient.subscribe('todo_alerts', (message) => {
        try {
            const todo = JSON.parse(message);
            alertEmitter.emit('todo_alert', todo);
        } catch (e) {
            console.error('Failed to handle incoming Redis message', e);
        }
    });
})();

const pool = new Pool({
    connectionString: process.env.POSTGRESQL_ADDON_URI,
});

const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS todos (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL CHECK(length(title) > 0),
                description TEXT,
                due_date DATE,
                status TEXT CHECK(status IN ('pending', 'done')) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const { rows } = await pool.query('SELECT count(*) FROM todos');
        if (parseInt(rows[0].count) === 0) {
            await pool.query(`
                INSERT INTO todos (title, description, due_date, status, created_at)
                VALUES ($1, $2, $3, $4, $5)
            `, ["Préparer la démo", null, "2024-12-01", "pending", "2024-11-20T10:00:00Z"]);
        }
    } catch (error) {
        console.error('Erreur lors de la création de la table:', error);
    }
};

initDB();

app.get('/health', async (req, res) => {
    let databaseStatus = 'disconnected';
    try {
        await pool.query('SELECT 1');
        databaseStatus = 'connected';
    } catch (err) {
        databaseStatus = 'disconnected';
        return res.status(500).json({ status: 'error', app: process.env.APP_NAME || 'MonApp', database: databaseStatus });
    }
    
    res.status(200).json({
        status: 'ok',
        app: process.env.APP_NAME,
        database: databaseStatus
    });
});

app.get('/todos/overdue', async (req, res) => {
    try {
        const query = `
            SELECT * FROM todos 
            WHERE status = 'pending' 
            AND due_date < CURRENT_DATE
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/todos', async (req, res) => {
    const status = req.query.status;
    let query = 'SELECT * FROM todos';
    let params = [];

    if (status) {
        if (status !== 'pending' && status !== 'done') {
            return res.status(400).json({ error: "Le paramètre status doit être 'pending' ou 'done'" });
        }
        query += ' WHERE status = $1';
        params.push(status);
    }

    try {
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/todos', async (req, res) => {
    const { title, description, due_date, status } = req.body;

    if (!title || title.trim() === '') {
        return res.status(400).json({ error: "Le champ 'title' est obligatoire et ne peut pas être vide" });
    }

    try {
        const { rows } = await pool.query(`
            INSERT INTO todos (title, description, due_date, status)
            VALUES ($1, $2, $3, COALESCE($4, 'pending'))
            RETURNING *
        `, [title.trim(), description || null, due_date || null, status || 'pending']);
        
        res.status(201).json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.patch('/todos/:id', async (req, res) => {
    const id = req.params.id;
    const updates = req.body;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "Aucun champ à mettre à jour" });
    }

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (['title', 'description', 'due_date', 'status'].includes(key)) {
            setClauses.push(`${key} = $${paramIndex}`);
            values.push(key === 'title' ? value.trim() : value);
            paramIndex++;
        }
    }

    if (setClauses.length === 0) {
        return res.status(400).json({ error: "Champs invalides" });
    }

    values.push(id);
    const query = `
        UPDATE todos
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
    `;

    try {
        const { rows } = await pool.query(query, values);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Todo non trouvé" });
        }
        res.json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/todos/:id', async (req, res) => {
    const id = req.params.id;
    
    try {
        const { rowCount } = await pool.query('DELETE FROM todos WHERE id = $1', [id]);
        
        if (rowCount === 0) {
            return res.status(404).json({ error: "Todo non trouvé" });
        }
        
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/todos/:id/notify', async (req, res) => {
    const id = req.params.id;

    try {
        const { rows } = await pool.query('SELECT id, title, status, due_date FROM todos WHERE id = $1', [id]);
        
        if (rows.length === 0) {
            return res.status(404).json({ error: "Todo non trouvé" });
        }

        const todo = rows[0];
        const listenersCount = alertEmitter.listenerCount('todo_alert');
        
        await pubClient.publish('todo_alerts', JSON.stringify(todo));

        res.status(200).json({ 
            message: "Alerte envoyée", 
            listeners: listenersCount 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/alerts', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const sendAlert = (todo) => {
        res.write('event: todo_alert\n');
        res.write(`data: ${JSON.stringify(todo)}\n\n`);
    };

    alertEmitter.on('todo_alert', sendAlert);

    const pingInterval = setInterval(() => {
        res.write(': ping\n\n');
    }, 30000);

    req.on('close', () => {
        clearInterval(pingInterval);
        alertEmitter.off('todo_alert', sendAlert);
    });
});

app.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    console.log(`Exemple d'appel : curl http://localhost:${PORT}/todos?status=pending`);
});

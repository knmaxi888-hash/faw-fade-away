const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";

const BARBER_PHONE = "5493718669138";

const HORARIOS = ["09:00","10:00","11:00","12:00","13:00","14:00","15:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];

let db = null;
let reservations = null;

app.use(express.json());

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.static(__dirname));

async function connectDB() {
    if (!MONGODB_URI) {
        console.log("[DB] No MONGODB_URI configurada");
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db("faw");
        reservations = db.collection("reservations");
        await reservations.createIndex({ date: 1 });
        console.log("[DB] Conectado a MongoDB");
    } catch (e) {
        console.error("[DB] Error conectando:", e.message);
    }
}

app.get("/api/reservations", async (req, res) => {
    if (reservations) {
        const data = await reservations.find({}).sort({ createdAt: -1 }).toArray();
        res.json(data);
    } else {
        res.json([]);
    }
});

app.get("/api/reserved-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        res.json(reserved.map(r => r.time));
    } else {
        res.json([]);
    }
});

app.post("/api/reservations", async (req, res) => {
    const newReservation = {
        id: Date.now(),
        name: req.body.name,
        apellido: req.body.apellido,
        date: req.body.date,
        time: req.body.time,
        status: "pendiente",
        payment: "pendiente",
        createdAt: new Date().toISOString()
    };
    if (reservations) {
        await reservations.insertOne(newReservation);
    }
    res.json({ success: true, reservation: newReservation });
});

app.put("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        const update = {};
        if (req.body.status) update.status = req.body.status;
        if (req.body.payment) update.payment = req.body.payment;
        await reservations.updateOne({ id: id }, { $set: update });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.delete("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        await reservations.deleteOne({ id: id });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.get("/api/available-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        const reservedTimes = reserved.map(r => r.time);
        res.json(HORARIOS.filter(h => !reservedTimes.includes(h)));
    } else {
        res.json(HORARIOS);
    }
});

app.get("/qr", (req, res) => {
    res.sendFile(path.join(__dirname, "qr.html"));
});

app.listen(PORT, async () => {
    console.log(`FAW Server corriendo en http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    await connectDB();
});

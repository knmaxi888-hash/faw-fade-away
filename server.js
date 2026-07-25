const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3000;
const DATA_FILE = path.join(__dirname, "reservations.json");

app.use(express.json());
app.use(express.static(__dirname));

function readData() {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            fs.writeFileSync(DATA_FILE, "[]");
            return [];
        }
        const data = fs.readFileSync(DATA_FILE, "utf8");
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function writeData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/reservations", (req, res) => {
    res.json(readData());
});

app.post("/api/reservations", (req, res) => {
    const reservations = readData();
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
    reservations.push(newReservation);
    writeData(reservations);
    res.json({ success: true, reservation: newReservation });
});

app.put("/api/reservations/:id", (req, res) => {
    const reservations = readData();
    const index = reservations.findIndex(r => r.id === parseInt(req.params.id));
    if (index !== -1) {
        if (req.body.status) reservations[index].status = req.body.status;
        if (req.body.payment) reservations[index].payment = req.body.payment;
        writeData(reservations);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Not found" });
    }
});

app.delete("/api/reservations/:id", (req, res) => {
    let reservations = readData();
    reservations = reservations.filter(r => r.id !== parseInt(req.params.id));
    writeData(reservations);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`FAW Server corriendo en http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
});

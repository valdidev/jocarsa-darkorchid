#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const http = require("http"); // Cambiado de 'https' a 'http'
const WebSocket = require("ws");

/**
 * Escucharemos en el puerto 3000, URL será http://localhost:3000
 */
const PORT = 3000;

// Almacenamiento en memoria para Teacher + Students
let teacherClient = null; // { ws, id, name, role: 'teacher' }
let students = []; // array of { ws, id, name, role: 'student' }

/**
 * Crear un servidor HTTP para servir archivos estáticos desde "./public"
 */
const server = http.createServer((req, res) => {
  // Si el usuario solicita "/", servir index.html
  if (req.url === "/" || req.url === "/index.html") {
    const filePath = path.join(__dirname, "public", "index.html");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end("Error loading index.html");
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  } else if (req.url === "/style.css") {
    const filePath = path.join(__dirname, "public", "style.css");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end(data);
    });
  } else if (req.url === "/script.js") {
    const filePath = path.join(__dirname, "public", "script.js");
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Not found");
      }
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

/**
 * Crear un servidor WebSocket (WS) sobre nuestro servidor HTTP
 */
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  let clientId = null;
  let role = null;
  let name = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.error("Invalid JSON from client:", data);
      return;
    }

    switch (msg.type) {
      case "join":
        role = msg.role;
        name = msg.name;
        clientId = generateId();

        if (role === "teacher") {
          console.log(`Teacher joined: ${name}, id=${clientId}`);
          teacherClient = { ws, id: clientId, name, role: "teacher" };
          ws.send(JSON.stringify({ type: "joined", role, id: clientId }));
        } else {
          console.log(`Student joined: ${name}, id=${clientId}`);
          students.push({ ws, id: clientId, name, role: "student" });
          ws.send(JSON.stringify({ type: "joined", role, id: clientId }));
          if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
            teacherClient.ws.send(
              JSON.stringify({
                type: "student-joined",
                studentId: clientId,
                name,
              })
            );
          }
        }

        broadcastAttendantsList();
        break;

      case "offer":
        forwardToStudent(msg.studentId, {
          type: "offer",
          sdp: msg.sdp,
          studentId: msg.studentId,
        });
        break;

      case "answer":
        if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
          teacherClient.ws.send(
            JSON.stringify({
              type: "answer",
              studentId: msg.studentId,
              sdp: msg.sdp,
            })
          );
        }
        break;

      case "ice-candidate":
        if (msg.target === "teacher") {
          if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
            teacherClient.ws.send(
              JSON.stringify({
                type: "ice-candidate",
                target: "teacher",
                studentId: msg.studentId,
                candidate: msg.candidate,
              })
            );
          }
        } else {
          forwardToStudent(msg.studentId, {
            type: "ice-candidate",
            target: "student",
            studentId: msg.studentId,
            candidate: msg.candidate,
          });
        }
        break;

      default:
        console.log("Unknown message type:", msg.type);
        break;
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected: role=${role}, id=${clientId}`);
    if (teacherClient && teacherClient.id === clientId) {
      teacherClient = null;
    } else {
      students = students.filter((s) => s.id !== clientId);
      if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
        teacherClient.ws.send(
          JSON.stringify({
            type: "student-left",
            studentId: clientId,
          })
        );
      }
    }

    broadcastAttendantsList();
  });
});

function forwardToStudent(studentId, msgObj) {
  const student = students.find((s) => s.id === studentId);
  if (student && student.ws.readyState === WebSocket.OPEN) {
    student.ws.send(JSON.stringify(msgObj));
  }
}

function broadcastAttendantsList() {
  const all = [];
  if (teacherClient) {
    all.push({
      id: teacherClient.id,
      name: teacherClient.name,
      role: "teacher",
    });
  }
  for (const s of students) {
    all.push({ id: s.id, name: s.name, role: "student" });
  }

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "attendants-list", list: all }));
    }
  });
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

server.listen(PORT, () => {
  console.log(`HTTP + WebSocket server on http://localhost:${PORT}`);
  console.log("Press CTRL+C to stop.");
});

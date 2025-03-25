#!/usr/bin/env node

/*******************************************************************
  server_ssl.js
  -------------
  1) Creates an HTTPS + WebSocket server on https://jocarsa.com:3000
  2) Serves static files from "./public"
  3) Handles Teacher/Student WebRTC signaling
  4) Broadcasts an attendants list (Teacher + Students) to everyone.

  HOW TO RUN:
    1) npm install ws
    2) node server_ssl.js
    3) Open https://jocarsa.com:3000

  Make sure:
    - DNS points jocarsa.com to this server.
    - You have a valid SSL cert + key for jocarsa.com.
    - Port 3000 is open in your firewall.
*******************************************************************/

const fs = require('fs');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

/** 
 * Replace these with your actual certificate and key file paths.
 * Example:
 *   /etc/apache2/ssl/jocarsa_combined.cer
 *   /etc/apache2/ssl/jocarsa.key
 */
const SSL_CERT_PATH = '/etc/apache2/ssl/jocarsa_combined.cer';
const SSL_KEY_PATH  = '/etc/apache2/ssl/jocarsa.key';

// Read your cert + key
const sslOptions = {
  cert: fs.readFileSync(SSL_CERT_PATH),
  key:  fs.readFileSync(SSL_KEY_PATH),
};

/**
 * We'll listen on port 3000, so the URL is https://jocarsa.com:3000
 */
const PORT = 3000;

// In-memory store for Teacher + Students
let teacherClient = null; // { ws, id, name, role: 'teacher' }
let students = [];        // array of { ws, id, name, role: 'student' }

/**
 * Create an HTTPS server to serve static files from "./public"
 */
const server = https.createServer(sslOptions, (req, res) => {
  // If user requests "/", serve index.html
  if (req.url === '/' || req.url === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading index.html');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
  else if (req.url === '/style.css') {
    const filePath = path.join(__dirname, 'public', 'style.css');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end(data);
    });
  }
  else if (req.url === '/script.js') {
    const filePath = path.join(__dirname, 'public', 'script.js');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(data);
    });
  }
  else {
    res.writeHead(404);
    res.end('Not found');
  }
});

/**
 * Create a WebSocket server (WSS) on top of our HTTPS server
 */
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let clientId = null;
  let role = null;
  let name = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (err) {
      console.error('Invalid JSON from client:', data);
      return;
    }

    switch (msg.type) {
      case 'join':
        // { type: 'join', role: 'teacher'|'student', name }
        role = msg.role;
        name = msg.name;
        clientId = generateId();

        if (role === 'teacher') {
          console.log(`Teacher joined: ${name}, id=${clientId}`);
          teacherClient = { ws, id: clientId, name, role: 'teacher' };
          ws.send(JSON.stringify({ type: 'joined', role, id: clientId }));
        } else {
          console.log(`Student joined: ${name}, id=${clientId}`);
          students.push({ ws, id: clientId, name, role: 'student' });
          ws.send(JSON.stringify({ type: 'joined', role, id: clientId }));
          // Notify teacher
          if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
            teacherClient.ws.send(JSON.stringify({
              type: 'student-joined',
              studentId: clientId,
              name
            }));
          }
        }

        // Broadcast updated attendants list to everyone
        broadcastAttendantsList();
        break;

      case 'offer':
        // Teacher -> Student
        // { type: 'offer', studentId, sdp }
        forwardToStudent(msg.studentId, {
          type: 'offer',
          sdp: msg.sdp,
          studentId: msg.studentId
        });
        break;

      case 'answer':
        // Student -> Teacher
        // { type: 'answer', studentId, sdp }
        if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
          teacherClient.ws.send(JSON.stringify({
            type: 'answer',
            studentId: msg.studentId,
            sdp: msg.sdp
          }));
        }
        break;

      case 'ice-candidate':
        // { type: 'ice-candidate', target, studentId, candidate }
        if (msg.target === 'teacher') {
          // Student -> Teacher
          if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
            teacherClient.ws.send(JSON.stringify({
              type: 'ice-candidate',
              target: 'teacher',
              studentId: msg.studentId,
              candidate: msg.candidate
            }));
          }
        } else {
          // Teacher -> Student
          forwardToStudent(msg.studentId, {
            type: 'ice-candidate',
            target: 'student',
            studentId: msg.studentId,
            candidate: msg.candidate
          });
        }
        break;

      default:
        console.log('Unknown message type:', msg.type);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: role=${role}, id=${clientId}`);
    // If teacher disconnected
    if (teacherClient && teacherClient.id === clientId) {
      teacherClient = null;
    } else {
      // Student disconnected
      students = students.filter(s => s.id !== clientId);
      if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
        teacherClient.ws.send(JSON.stringify({
          type: 'student-left',
          studentId: clientId
        }));
      }
    }

    // Broadcast updated attendants list to everyone
    broadcastAttendantsList();
  });
});

/**
 * Forward a message to a particular Student by ID
 */
function forwardToStudent(studentId, msgObj) {
  const student = students.find(s => s.id === studentId);
  if (student && student.ws.readyState === WebSocket.OPEN) {
    student.ws.send(JSON.stringify(msgObj));
  }
}

/**
 * Broadcast the updated list of all attendants (Teacher + Students)
 * to every connected socket.
 */
function broadcastAttendantsList() {
  const all = [];
  // Include teacher if present
  if (teacherClient) {
    all.push({ id: teacherClient.id, name: teacherClient.name, role: 'teacher' });
  }
  // Include all students
  for (const s of students) {
    all.push({ id: s.id, name: s.name, role: 'student' });
  }

  // Send { type: 'attendants-list', list: [...] } to everyone
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'attendants-list', list: all }));
    }
  });
}

/**
 * Generate a random client ID
 */
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Start listening
 */
server.listen(PORT, () => {
  console.log(`HTTPS + WebSocket server on https://jocarsa.com:${PORT}`);
  console.log('Press CTRL+C to stop.');
});


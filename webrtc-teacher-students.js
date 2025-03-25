#!/usr/bin/env node

/*******************************************************************
  A SINGLE-FILE EXAMPLE:
    - Node.js HTTP + WebSocket server (for signaling)
    - A single HTML/JS client (served at "/")
    - Teacher streams screen+cam+mic to multiple Students via WebRTC
    - Basic text chat via data channel
*******************************************************************/

//
// 1) SERVER CODE (Node + WebSocket for signaling)
//

const http = require('http');
const WebSocket = require('ws');

const PORT = 3000;

/**
 * We'll keep a simple in-memory list of connected clients:
 *   - teacherClient: the single Teacher’s WebSocket (null if none)
 *   - students: an array of { ws, id, name } for each Student
 *
 * Each Student needs a separate RTCPeerConnection with the Teacher.
 * So the Teacher’s browser creates a new RTCPeerConnection for each Student.
 * We handle Offer/Answer/ICE exchange via WebSocket messages.
 */
let teacherClient = null;
let students = [];

/**
 * Create a minimal HTTP server that serves our single-page app.
 */
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    // Serve the single HTML page with inline JS
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML_PAGE);
  } else {
    // Not found
    res.writeHead(404);
    res.end();
  }
});

/**
 * Create a WebSocket server on top of our HTTP server.
 */
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  // Each client (Teacher or Student) will send us a "join" message with a role and name.
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

    // Handle the various message types from clients
    switch (msg.type) {
      case 'join':
        // { type: 'join', role: 'teacher'|'student', name: '...' }
        role = msg.role;
        name = msg.name;
        clientId = generateId();
        if (role === 'teacher') {
          console.log(`Teacher joined: ${name}, id=${clientId}`);
          // If there's already a teacher, we override (or you can refuse).
          teacherClient = { ws, id: clientId, name };
          // Let the teacher know they joined
          ws.send(JSON.stringify({ type: 'joined', role, id: clientId }));
        } else {
          console.log(`Student joined: ${name}, id=${clientId}`);
          // Add to students array
          students.push({ ws, id: clientId, name });
          // Let the student know they joined
          ws.send(JSON.stringify({ type: 'joined', role, id: clientId }));
          // Also notify the teacher that a new student joined
          if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
            teacherClient.ws.send(JSON.stringify({
              type: 'student-joined',
              studentId: clientId,
              name
            }));
          }
        }
        break;

      case 'offer':
        // { type: 'offer', studentId, sdp }
        // This is from Teacher -> a specific Student
        // Forward to that student
        forwardToStudent(msg.studentId, {
          type: 'offer',
          sdp: msg.sdp,
          studentId: msg.studentId
        });
        break;

      case 'answer':
        // { type: 'answer', studentId, sdp }
        // This is from Student -> Teacher
        // Forward to the teacher
        if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
          teacherClient.ws.send(JSON.stringify({
            type: 'answer',
            studentId: msg.studentId,
            sdp: msg.sdp
          }));
        }
        break;

      case 'ice-candidate':
        // { type: 'ice-candidate', target: 'teacher'|'student', studentId, candidate }
        // Forward ICE to the appropriate side
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

    // If Teacher disconnected, remove
    if (teacherClient && teacherClient.id === clientId) {
      teacherClient = null;
      // Optionally notify all students that teacher left
    } else {
      // Remove from students
      students = students.filter((s) => s.id !== clientId);
      // Notify teacher that this student left
      if (teacherClient && teacherClient.ws.readyState === WebSocket.OPEN) {
        teacherClient.ws.send(JSON.stringify({
          type: 'student-left',
          studentId: clientId
        }));
      }
    }
  });
});

/**
 * Utility: forward a message to one Student by ID
 */
function forwardToStudent(studentId, msgObj) {
  let student = students.find(s => s.id === studentId);
  if (student && student.ws.readyState === WebSocket.OPEN) {
    student.ws.send(JSON.stringify(msgObj));
  }
}

/**
 * Utility: generate a random ID
 */
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

/**
 * Start the server
 */
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Press CTRL+C to stop.');
});


//
// 2) CLIENT CODE (HTML + inline JavaScript)
//    This is served at http://localhost:3000/
//

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Teacher/Student WebRTC</title>
  <style>
    body {
      margin: 0; padding: 0;
      font-family: sans-serif;
      display: flex; flex-direction: row; height: 100vh;
    }
    #chat-container {
      width: 300px;
      border-right: 1px solid #ccc;
      display: flex;
      flex-direction: column;
    }
    #chat-messages {
      flex: 1;
      overflow-y: auto;
      margin: 0; padding: 10px;
      border-bottom: 1px solid #ccc;
      white-space: pre-wrap;
    }
    #chat-input-container {
      display: flex; margin: 0; padding: 10px; box-sizing: border-box;
    }
    #chat-input {
      flex: 1; margin-right: 5px;
    }
    #video-container {
      flex: 1; display: flex; flex-wrap: wrap; align-items: flex-start;
      justify-content: flex-start; padding: 10px; box-sizing: border-box;
    }
    video {
      width: 300px;
      margin: 5px;
      background: #000;
    }
    #loginOverlay {
      position: fixed; top:0; left:0; right:0; bottom:0;
      background-color: rgba(0,0,0,0.8);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: #fff;
    }
    #loginBox {
      background: #333; padding: 20px; border-radius: 5px;
    }
    #loginBox label { display: block; margin: 10px 0 5px; }
    .hidden { display: none; }
  </style>
</head>
<body>
<div id="chat-container">
  <div id="chat-messages"></div>
  <div id="chat-input-container">
    <input type="text" id="chat-input" placeholder="Type message...">
    <button id="chat-send-btn">Send</button>
  </div>
</div>
<div id="video-container">
  <!-- Teacher sees localVideo + remote(s).
       Students see just remoteVideo (the teacher's feed). -->
</div>

<!-- Login overlay -->
<div id="loginOverlay">
  <div id="loginBox">
    <h2>Login</h2>
    <label>Your Name:</label>
    <input id="nameField" type="text" placeholder="Your name" />
    <div style="margin-top: 10px;">
      <label><input type="radio" name="role" value="teacher" checked>Teacher</label>
      <label><input type="radio" name="role" value="student">Student</label>
    </div>
    <button id="loginBtn" style="margin-top: 20px;">Login</button>
  </div>
</div>

<script>
  /********************************************************
   * Basic WebSocket-based Signaling
   ********************************************************/
  const wsProtocol = (location.protocol === 'https:') ? 'wss://' : 'ws://';
  const wsUrl = wsProtocol + window.location.host;
  const ws = new WebSocket(wsUrl);

  let localStream = null;  // Teacher's combined stream of screen+cam+mic
  let pcStudents = {};     // On Teacher side: a map of studentId -> RTCPeerConnection
  let pcTeacher   = null;  // On Student side: the RTCPeerConnection with the Teacher
  let dataChannels = {};   // dataChannels[studentId] => RTCDataChannel (Teacher side)
  let dataChannelTeacher = null; // (Student side)
  let userRole = null;
  let userName = null;
  let userId = null;

  // Chat UI
  const chatMessagesDiv = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');

  // Video container
  const videoContainer = document.getElementById('video-container');

  // Login overlay
  const loginOverlay = document.getElementById('loginOverlay');
  const loginBtn = document.getElementById('loginBtn');
  const nameField = document.getElementById('nameField');

  // When the user clicks "Login"
  loginBtn.onclick = async () => {
    userName = nameField.value.trim() || 'Anonymous';
    const roleRadio = document.querySelector('input[name="role"]:checked');
    userRole = roleRadio.value;

    // Send "join" message over WebSocket
    ws.send(JSON.stringify({
      type: 'join',
      role: userRole,
      name: userName
    }));
  };

  // WebSocket open
  ws.onopen = () => {
    console.log('WebSocket connected to server.');
  };

  // WebSocket message
  ws.onmessage = async (event) => {
    let msg = JSON.parse(event.data);
    switch (msg.type) {
      case 'joined':
        // { type: 'joined', role, id }
        userRole = msg.role;
        userId   = msg.id;
        // Hide login overlay
        loginOverlay.classList.add('hidden');
        console.log(\`Joined as \${userRole}, id=\${userId}\`);

        if (userRole === 'teacher') {
          // Teacher: get screen+camera+mic
          startTeacher();
        } else {
          // Student: wait for an offer from Teacher
          startStudent();
        }
        break;

      case 'student-joined':
        // (Teacher side) a new student connected
        // { type: 'student-joined', studentId, name }
        console.log(\`New student joined: \${msg.name} (\${msg.studentId})\`);
        // Create a peer connection for that student
        createPeerConnectionForStudent(msg.studentId);
        break;

      case 'student-left':
        // (Teacher side) remove that student's PC
        // { type: 'student-left', studentId }
        if (pcStudents[msg.studentId]) {
          pcStudents[msg.studentId].close();
          delete pcStudents[msg.studentId];
        }
        if (dataChannels[msg.studentId]) {
          delete dataChannels[msg.studentId];
        }
        break;

      case 'offer':
        // (Student side) we got an offer from the Teacher
        // { type: 'offer', sdp, studentId } => but studentId is my ID
        if (userRole === 'student') {
          console.log('Received Offer from Teacher');
          await pcTeacher.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await pcTeacher.createAnswer();
          await pcTeacher.setLocalDescription(answer);

          // Send our answer back via WS
          ws.send(JSON.stringify({
            type: 'answer',
            studentId: userId,
            sdp: pcTeacher.localDescription
          }));
        }
        break;

      case 'answer':
        // (Teacher side) we got an answer from a Student
        // { type: 'answer', studentId, sdp }
        if (userRole === 'teacher') {
          const pc = pcStudents[msg.studentId];
          if (pc) {
            console.log(\`Received Answer from student \${msg.studentId}\`);
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          }
        }
        break;

      case 'ice-candidate':
        // { type: 'ice-candidate', target, studentId, candidate }
        if (msg.target === 'teacher' && userRole === 'teacher') {
          // Student -> Teacher
          const pc = pcStudents[msg.studentId];
          if (pc && msg.candidate) {
            pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        } else if (msg.target === 'student' && userRole === 'student') {
          // Teacher -> Student
          if (pcTeacher && msg.candidate) {
            pcTeacher.addIceCandidate(new RTCIceCandidate(msg.candidate));
          }
        }
        break;

      default:
        console.log('Unknown message from server:', msg);
    }
  };

  /********************************************************
   * TEACHER LOGIC
   ********************************************************/
  async function startTeacher() {
    try {
      // 1) Get media: screen, camera, microphone
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const camStream    = await navigator.mediaDevices.getUserMedia({ video: true });
      const micStream    = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Combine all into one localStream so we can show locally
      localStream = new MediaStream();
      for (let track of screenStream.getTracks()) localStream.addTrack(track);
      for (let track of camStream.getVideoTracks()) localStream.addTrack(track);
      for (let track of micStream.getTracks()) localStream.addTrack(track);

      // Show local preview (Teacher’s own feed)
      const localVideo = document.createElement('video');
      localVideo.autoplay = true;
      localVideo.muted = true;
      localVideo.playsInline = true;
      localVideo.srcObject = localStream;
      videoContainer.appendChild(localVideo);

      console.log('Teacher ready. Will create peer connections as students join.');
    } catch (err) {
      console.error('Error capturing media:', err);
      alert('Could not capture screen/camera/mic: ' + err);
    }
  }

  function createPeerConnectionForStudent(studentId) {
    // Configuration (Google STUN)
    const config = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    const pc = new RTCPeerConnection(config);

    // Add tracks from localStream to this peer
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // Create data channel for chat with this student
    const dataChannel = pc.createDataChannel('chatChannel');
    dataChannels[studentId] = dataChannel;
    setupDataChannel(dataChannel, studentId);

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({
          type: 'ice-candidate',
          target: 'student',
          studentId,
          candidate: event.candidate
        }));
      }
    };

    // We (Teacher) don't need to watch ontrack for the Student, but we could
    // if we wanted to see student's camera. For now, Teacher doesn't watch Student.

    // Create the offer for this student
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer).then(() => {
        // Send offer via WebSocket to the student
        ws.send(JSON.stringify({
          type: 'offer',
          studentId,
          sdp: pc.localDescription
        }));
      });
    });

    // Store it
    pcStudents[studentId] = pc;
  }

  /********************************************************
   * STUDENT LOGIC
   ********************************************************/
  function startStudent() {
    // Create one peer connection to the Teacher
    const config = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
    pcTeacher = new RTCPeerConnection(config);

    // ICE candidates (Student -> Teacher)
    pcTeacher.onicecandidate = (event) => {
      if (event.candidate) {
        ws.send(JSON.stringify({
          type: 'ice-candidate',
          target: 'teacher',
          studentId: userId,  // my own ID
          candidate: event.candidate
        }));
      }
    };

    // On track (this is the Teacher’s feed)
    pcTeacher.ontrack = (event) => {
      // If multiple tracks, they may come in separately. Usually .streams[0] is good.
      // We can attach them all to a single video, or separate videos if we want.
      const remoteVideo = getOrCreateRemoteVideo();
      if (!remoteVideo.srcObject) {
        remoteVideo.srcObject = event.streams[0];
      } else {
        // If needed, add tracks to existing stream
        let existingStream = remoteVideo.srcObject;
        existingStream.addTrack(event.track);
      }
    };

    // On data channel (from Teacher)
    pcTeacher.ondatachannel = (event) => {
      dataChannelTeacher = event.channel;
      setupDataChannelStudent(dataChannelTeacher);
    };

    console.log('Student ready and waiting for an Offer from Teacher...');
  }

  // Helper to create or reuse a single <video> for the Teacher's feed
  function getOrCreateRemoteVideo() {
    let remoteVideo = document.getElementById('teacher-video');
    if (!remoteVideo) {
      remoteVideo = document.createElement('video');
      remoteVideo.id = 'teacher-video';
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      videoContainer.appendChild(remoteVideo);
    }
    return remoteVideo;
  }

  /********************************************************
   * Data Channels (for chat)
   ********************************************************/
  // Teacher side: handle a brand new data channel to a Student
  function setupDataChannel(dc, studentId) {
    dc.onopen = () => {
      console.log(\`DataChannel open (Teacher->Student \${studentId})\`);
      // Optionally send a welcome message
      dc.send(\`\${userName} (Teacher) joined the chat.\`);
    };
    dc.onmessage = (evt) => {
      addChatMessage(\`Student \${studentId}\`, evt.data);
    };
    dc.onclose = () => {
      console.log(\`DataChannel closed (Teacher->Student \${studentId})\`);
    };
  }

  // Student side: handle the Teacher->Student data channel
  function setupDataChannelStudent(dc) {
    dc.onopen = () => {
      console.log('DataChannel open (Student->Teacher)');
    };
    dc.onmessage = (evt) => {
      addChatMessage('Teacher', evt.data);
    };
    dc.onclose = () => {
      console.log('DataChannel closed (Student->Teacher)');
    };
  }

  // UI: send chat message
  chatSendBtn.onclick = () => {
    const msg = chatInput.value;
    chatInput.value = '';
    if (!msg.trim()) return;

    if (userRole === 'teacher') {
      // Send to each student's data channel
      for (const [stuId, dc] of Object.entries(dataChannels)) {
        if (dc.readyState === 'open') {
          dc.send(\`\${userName} (Teacher): \${msg}\`);
        }
      }
      addChatMessage(\`\${userName} (Teacher)\`, msg);
    } else {
      // Student -> Teacher
      if (dataChannelTeacher && dataChannelTeacher.readyState === 'open') {
        dataChannelTeacher.send(\`\${userName} (Student): \${msg}\`);
      }
      addChatMessage(\`\${userName} (Student)\`, msg);
    }
  };

  function addChatMessage(who, text) {
    console.log(\`[CHAT] \${who}: \${text}\`);
    const div = document.createElement('div');
    div.textContent = \`\${who}: \${text}\`;
    chatMessagesDiv.appendChild(div);
    chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
  }

</script>
</body>
</html>
`;

/*******************************************************************
  END OF SINGLE-FILE EXAMPLE
*******************************************************************/


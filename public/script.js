/********************************************************
 * script.js
 * Client-side JS for Teacher/Student WebRTC with chat
 ********************************************************/
const wsProtocol = (location.protocol === 'https:') ? 'wss://' : 'ws://';
const wsUrl = wsProtocol + window.location.host;
const ws = new WebSocket(wsUrl);

// Global state
let userRole   = null;   // "teacher" or "student"
let userName   = null;   // typed name
let userId     = null;   // assigned by server
let localStream = null;  // Teacher's combined screen+cam+mic
let pcStudents = {};     // Teacher side: studentId -> RTCPeerConnection
let pcTeacher  = null;   // Student side: single RTCPeerConnection to teacher
let dataChannels = {};   // Teacher side: studentId -> dataChannel
let dataChannelTeacher = null; // Student side: dataChannel to teacher

// DOM elements
const loginOverlay      = document.getElementById('loginOverlay');
const loginBtn          = document.getElementById('loginBtn');
const nameField         = document.getElementById('nameField');

const chatMessagesDiv   = document.getElementById('chat-messages');
const chatInput         = document.getElementById('chat-input');
const chatSendBtn       = document.getElementById('chat-send-btn');
const videoContainer    = document.getElementById('video-container');

// When user clicks "Login"
loginBtn.onclick = () => {
  userName = nameField.value.trim() || 'Anonymous';
  const roleRadio = document.querySelector('input[name="role"]:checked');
  userRole = roleRadio.value;

  // Send "join" message
  ws.send(JSON.stringify({
    type: 'join',
    role: userRole,
    name: userName
  }));
};

ws.onopen = () => {
  console.log('WebSocket connected.');
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'joined':
      // { type: 'joined', role, id }
      userRole = msg.role;
      userId   = msg.id;
      // Hide login overlay
      loginOverlay.classList.add('hidden');
      console.log(`Joined as ${userRole}, id=${userId}`);

      if (userRole === 'teacher') {
        startTeacher();
      } else {
        startStudent();
      }
      break;

    case 'student-joined':
      // Teacher side: new student
      // { type: 'student-joined', studentId, name }
      console.log(`New student joined: ${msg.name} (id=${msg.studentId})`);
      createPeerConnectionForStudent(msg.studentId);
      break;

    case 'student-left':
      // Teacher side: remove that student's PC
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
      // Student side: got an offer from Teacher
      // { type: 'offer', sdp, studentId }
      if (userRole === 'student') {
        console.log('Received Offer from Teacher');
        await pcTeacher.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pcTeacher.createAnswer();
        await pcTeacher.setLocalDescription(answer);

        // Send answer back
        ws.send(JSON.stringify({
          type: 'answer',
          studentId: userId,
          sdp: pcTeacher.localDescription
        }));
      }
      break;

    case 'answer':
      // Teacher side: got answer from a Student
      // { type: 'answer', studentId, sdp }
      if (userRole === 'teacher') {
        const pc = pcStudents[msg.studentId];
        if (pc) {
          console.log(`Received Answer from student ${msg.studentId}`);
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
      console.log('Unknown message:', msg);
  }
};

/********************************************************
 * TEACHER LOGIC
 ********************************************************/
async function startTeacher() {
  try {
    // Get screen, camera, mic
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const camStream    = await navigator.mediaDevices.getUserMedia({ video: true });
    const micStream    = await navigator.mediaDevices.getUserMedia({ audio: true });

    // Combine them into localStream
    localStream = new MediaStream();
    screenStream.getTracks().forEach(t => localStream.addTrack(t));
    camStream.getVideoTracks().forEach(t => localStream.addTrack(t));
    micStream.getTracks().forEach(t => localStream.addTrack(t));

    // Show local preview
    const localVideo = document.createElement('video');
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.srcObject = localStream;
    videoContainer.appendChild(localVideo);

    console.log('Teacher ready.');
  } catch (err) {
    console.error('Error capturing media:', err);
    alert('Could not capture screen/camera/mic: ' + err);
  }
}

function createPeerConnectionForStudent(studentId) {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const pc = new RTCPeerConnection(config);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // Create a data channel for chat
  const dc = pc.createDataChannel('chatChannel');
  dataChannels[studentId] = dc;
  setupDataChannelTeacher(dc, studentId);

  // ICE
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

  // No ontrack needed (we don't watch the student's camera).

  // Create offer
  pc.createOffer()
    .then(offer => {
      pc.setLocalDescription(offer).then(() => {
        ws.send(JSON.stringify({
          type: 'offer',
          studentId,
          sdp: pc.localDescription
        }));
      });
    });

  pcStudents[studentId] = pc;
}

function setupDataChannelTeacher(dc, studentId) {
  dc.onopen = () => {
    console.log(`DataChannel open (Teacher->Student ${studentId})`);
    // Send a welcome message
    dc.send(`${userName} (Teacher) joined the chat.`);
  };
  dc.onmessage = (evt) => {
    addChatMessage(`Student ${studentId}`, evt.data);
  };
  dc.onclose = () => {
    console.log(`DataChannel closed (Teacher->Student ${studentId})`);
  };
}

/********************************************************
 * STUDENT LOGIC
 ********************************************************/
function startStudent() {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  pcTeacher = new RTCPeerConnection(config);

  pcTeacher.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({
        type: 'ice-candidate',
        target: 'teacher',
        studentId: userId,
        candidate: event.candidate
      }));
    }
  };

  // On track (teacher's feed)
  pcTeacher.ontrack = (event) => {
    const remoteVideo = getOrCreateRemoteVideo();
    // If no srcObject, set the first stream
    if (!remoteVideo.srcObject) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      // If needed, add track to existing stream
      remoteVideo.srcObject.addTrack(event.track);
    }
  };

  // On data channel (from teacher)
  pcTeacher.ondatachannel = (evt) => {
    dataChannelTeacher = evt.channel;
    setupDataChannelStudent(dataChannelTeacher);
  };

  console.log('Student ready. Waiting for offer...');
}

function getOrCreateRemoteVideo() {
  let rv = document.getElementById('teacher-video');
  if (!rv) {
    rv = document.createElement('video');
    rv.id = 'teacher-video';
    rv.autoplay = true;
    rv.playsInline = true;
    videoContainer.appendChild(rv);
  }
  return rv;
}

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

/********************************************************
 * Chat UI
 ********************************************************/
chatSendBtn.onclick = () => {
  const msg = chatInput.value;
  chatInput.value = '';
  if (!msg.trim()) return;

  if (userRole === 'teacher') {
    // Send to each student
    for (const [stuId, dc] of Object.entries(dataChannels)) {
      if (dc.readyState === 'open') {
        dc.send(`${userName} (Teacher): ${msg}`);
      }
    }
    addChatMessage(`${userName} (Teacher)`, msg);
  } else {
    // Student -> Teacher
    if (dataChannelTeacher && dataChannelTeacher.readyState === 'open') {
      dataChannelTeacher.send(`${userName} (Student): ${msg}`);
    }
    addChatMessage(`${userName} (Student)`, msg);
  }
};

function addChatMessage(who, text) {
  console.log(`[CHAT] ${who}: ${text}`);
  const div = document.createElement('div');
  div.textContent = `${who}: ${text}`;
  chatMessagesDiv.appendChild(div);
  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
}


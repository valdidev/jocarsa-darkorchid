/********************************************************
 * script.js
 * Client-side code for Teacher/Student WebRTC with chat,
 * now with an attendants list and a fullscreen toggle.
 ********************************************************/
const wsUrl = "ws://localhost:3000"; // Forzado a ws:// para entorno local
const ws = new WebSocket(wsUrl);

// Global state
let userRole = null; // "teacher" or "student"
let userName = null; // typed name
let userId = null; // assigned by server
let localStream = null; // Teacher's combined screen+cam+mic
let pcStudents = {}; // Teacher side: studentId -> RTCPeerConnection
let pcTeacher = null; // Student side: single RTCPeerConnection to teacher
let dataChannels = {}; // Teacher side: studentId -> dataChannel
let dataChannelTeacher = null; // Student side: dataChannel to teacher

// DOM elements
const loginOverlay = document.getElementById("loginOverlay");
const loginBtn = document.getElementById("loginBtn");
const nameField = document.getElementById("nameField");

const chatMessagesDiv = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

const attendantsListDiv = document.getElementById("attendants-list");

const fullscreenBtn = document.getElementById("fullscreenBtn");
const videoContainer = document.getElementById("video-container");

// When user clicks "Login"
loginBtn.onclick = () => {
  userName = nameField.value.trim() || "Anonymous";
  const roleRadio = document.querySelector('input[name="role"]:checked');
  userRole = roleRadio.value;

  // Send "join"
  ws.send(
    JSON.stringify({
      type: "join",
      role: userRole,
      name: userName,
    })
  );
};

ws.onopen = () => {
  console.log("WebSocket connected.");
};

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case "joined":
      userRole = msg.role;
      userId = msg.id;
      loginOverlay.classList.add("hidden");
      console.log(`Joined as ${userRole}, id=${userId}`);

      if (userRole === "teacher") {
        startTeacher();
      } else {
        startStudent();
      }
      break;

    case "student-joined":
      console.log(`New student joined: ${msg.name} (id=${msg.studentId})`);
      createPeerConnectionForStudent(msg.studentId);
      break;

    case "student-left":
      if (pcStudents[msg.studentId]) {
        pcStudents[msg.studentId].close();
        delete pcStudents[msg.studentId];
      }
      if (dataChannels[msg.studentId]) {
        delete dataChannels[msg.studentId];
      }
      break;

    case "offer":
      if (userRole === "student") {
        console.log("Received Offer from Teacher");
        await pcTeacher.setRemoteDescription(
          new RTCSessionDescription(msg.sdp)
        );
        const answer = await pcTeacher.createAnswer();
        await pcTeacher.setLocalDescription(answer);

        ws.send(
          JSON.stringify({
            type: "answer",
            studentId: userId,
            sdp: pcTeacher.localDescription,
          })
        );
      }
      break;

    case "answer":
      if (userRole === "teacher") {
        const pc = pcStudents[msg.studentId];
        if (pc) {
          console.log(`Received Answer from student ${msg.studentId}`);
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
      }
      break;

    case "ice-candidate":
      if (msg.target === "teacher" && userRole === "teacher") {
        const pc = pcStudents[msg.studentId];
        if (pc && msg.candidate) {
          pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      } else if (msg.target === "student" && userRole === "student") {
        if (pcTeacher && msg.candidate) {
          pcTeacher.addIceCandidate(new RTCIceCandidate(msg.candidate));
        }
      }
      break;

    case "attendants-list":
      displayAttendants(msg.list);
      break;

    default:
      console.log("Unknown message:", msg);
  }
};

/********************************************************
 * TEACHER LOGIC
 ********************************************************/
async function startTeacher() {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
    });
    const camStream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    localStream = new MediaStream();
    screenStream.getTracks().forEach((t) => localStream.addTrack(t));
    camStream.getVideoTracks().forEach((t) => localStream.addTrack(t));
    micStream.getTracks().forEach((t) => localStream.addTrack(t));

    const localVideo = document.createElement("video");
    localVideo.autoplay = true;
    localVideo.muted = true;
    localVideo.playsInline = true;
    localVideo.controls = true;
    localVideo.srcObject = localStream;
    videoContainer.appendChild(localVideo);

    console.log("Teacher ready.");
  } catch (err) {
    console.error("Error capturing media:", err);
    alert("Could not capture screen/camera/mic: " + err);
  }
}

function createPeerConnectionForStudent(studentId) {
  const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  const pc = new RTCPeerConnection(config);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  const dc = pc.createDataChannel("chatChannel");
  dataChannels[studentId] = dc;
  setupDataChannelTeacher(dc, studentId);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "ice-candidate",
          target: "student",
          studentId,
          candidate: event.candidate,
        })
      );
    }
  };

  pc.createOffer().then((offer) => {
    pc.setLocalDescription(offer).then(() => {
      ws.send(
        JSON.stringify({
          type: "offer",
          studentId,
          sdp: pc.localDescription,
        })
      );
    });
  });

  pcStudents[studentId] = pc;
}

function setupDataChannelTeacher(dc, studentId) {
  dc.onopen = () => {
    console.log(`DataChannel open (Teacher->Student ${studentId})`);
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
  const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  pcTeacher = new RTCPeerConnection(config);

  pcTeacher.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "ice-candidate",
          target: "teacher",
          studentId: userId,
          candidate: event.candidate,
        })
      );
    }
  };

  pcTeacher.ontrack = (event) => {
    const remoteVideo = getOrCreateRemoteVideo();
    if (!remoteVideo.srcObject) {
      remoteVideo.srcObject = event.streams[0];
    } else {
      remoteVideo.srcObject.addTrack(event.track);
    }
  };

  pcTeacher.ondatachannel = (evt) => {
    dataChannelTeacher = evt.channel;
    setupDataChannelStudent(dataChannelTeacher);
  };

  console.log("Student ready. Waiting for offer...");
}

function getOrCreateRemoteVideo() {
  let rv = document.getElementById("teacher-video");
  if (!rv) {
    rv = document.createElement("video");
    rv.id = "teacher-video";
    rv.autoplay = true;
    rv.playsInline = true;
    videoContainer.appendChild(rv);
  }
  return rv;
}

function setupDataChannelStudent(dc) {
  dc.onopen = () => {
    console.log("DataChannel open (Student->Teacher)");
  };
  dc.onmessage = (evt) => {
    addChatMessage("Teacher", evt.data);
  };
  dc.onclose = () => {
    console.log("DataChannel closed (Student->Teacher)");
  };
}

/********************************************************
 * Chat UI: send on button or Enter
 ********************************************************/
chatSendBtn.onclick = sendChat;

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

function sendChat() {
  const msg = chatInput.value;
  chatInput.value = "";
  if (!msg.trim()) return;

  if (userRole === "teacher") {
    for (const [stuId, dc] of Object.entries(dataChannels)) {
      if (dc.readyState === "open") {
        dc.send(`${userName} (Teacher): ${msg}`);
      }
    }
    addChatMessage(`${userName} (Teacher)`, msg);
  } else {
    if (dataChannelTeacher && dataChannelTeacher.readyState === "open") {
      dataChannelTeacher.send(`${userName} (Student): ${msg}`);
    }
    addChatMessage(`${userName} (Student)`, msg);
  }
}

function addChatMessage(who, text) {
  const div = document.createElement("div");
  div.textContent = `${who}: ${text}`;
  chatMessagesDiv.appendChild(div);
  chatMessagesDiv.scrollTop = chatMessagesDiv.scrollHeight;
}

/********************************************************
 * Attendants List
 ********************************************************/
function displayAttendants(list) {
  attendantsListDiv.innerHTML = "";
  list.forEach((person) => {
    const p = document.createElement("p");
    p.textContent = person.role.toUpperCase() + " - " + person.name;
    attendantsListDiv.appendChild(p);
  });
}

/********************************************************
 * Fullscreen Button
 ********************************************************/
fullscreenBtn.onclick = () => {
  if (!document.fullscreenElement) {
    videoContainer.requestFullscreen().catch((err) => {
      console.error("Error attempting fullscreen:", err);
    });
  } else {
    document.exitFullscreen();
  }
};

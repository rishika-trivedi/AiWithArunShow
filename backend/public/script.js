// ===============================
// NAV MENU
// ===============================
const navLinks = document.querySelectorAll(".nav-menu .nav-link");
const menuOpenButton = document.querySelector("#menu-open-button");
const menuCloseButton = document.querySelector("#menu-close-button");

menuOpenButton.addEventListener("click", () => {
  document.body.classList.toggle("show-mobile-menu");
});
menuCloseButton.addEventListener("click", () => menuOpenButton.click());
navLinks.forEach((link) => {
  link.addEventListener("click", () => menuOpenButton.click());
});

// ===============================
// SWIPER
// ===============================
const swiper = new Swiper(".slider-wrapper", {
  loop: true,
  grabCursor: true,
  spaceBetween: 25,
  pagination: {
    el: ".swiper-pagination",
    clickable: true,
    dynamicBullets: true,
  },
  navigation: {
    nextEl: ".swiper-button-next",
    prevEl: ".swiper-button-prev",
  },
  breakpoints: {
    0: { slidesPerView: 1 },
    768: { slidesPerView: 2 },
    1024: { slidesPerView: 3 },
  },
});

// ===============================
// CHATBOT SETUP
// ===============================
const chatBody = document.querySelector(".chat-body");
const messageInput = document.querySelector(".message-input");
const sendMessageButton = document.querySelector("#send-message");
const fileInput = document.querySelector("#file-input");
const fileUploadWrapper = document.querySelector(".file-uploud-wrapper");
const fileCancelButton = document.querySelector("#file-cancel");
const chatbotToggler = document.querySelector("#chatbot-toggler");
const closeChatbot = document.querySelector("#close-chatbot");

const userData = { message: "", file: {} };
const initialInputHeight = messageInput.scrollHeight;

// ===============================
// HELPERS
// ===============================
const createMessageElement = (content, ...classes) => {
  const div = document.createElement("div");
  div.classList.add("message", ...classes);
  div.innerHTML = content;
  return div;
};

// ⚠️ YOUR RENDER BACKEND
const API_BASE = "https://aiwitharunshow.onrender.com";

// ===============================
// BOT RESPONSE
// ===============================
const generateBotResponse = async (incomingMessageDiv) => {
  const messageElement = incomingMessageDiv.querySelector(".message-text");

  try {
    const response = await fetch(`${API_BASE}/api/gemini`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: userData.message }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message || "Backend error");
    }

    // ✅ Backend shortcut response (latest episode, guardrails)
    if (data?.message) {
      messageElement.innerText = data.message;
      return;
    }

    // ✅ Normal Gemini response
    const text =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "I couldn’t generate a response.";

    messageElement.innerText = text;
  } catch (err) {
    console.error(err);
    messageElement.innerText = "Something went wrong. Check console.";
    messageElement.style.color = "red";
  } finally {
    incomingMessageDiv.classList.remove("thinking");
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
  }
};

// ===============================
// SEND MESSAGE
// ===============================
const handleOutgoingMessage = (e) => {
  e.preventDefault();

  userData.message = messageInput.value.trim();
  if (!userData.message) return;

  messageInput.value = "";
  fileUploadWrapper.classList.remove("file-uplouded");
  messageInput.dispatchEvent(new Event("input"));

  const outgoing = createMessageElement(
    `<div class="message-text"></div>`,
    "user-message"
  );
  outgoing.querySelector(".message-text").innerText = userData.message;
  chatBody.appendChild(outgoing);
  chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });

  setTimeout(() => {
    const botMessage = createMessageElement(
      `<svg class="bot-avatar" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
        <path d="M738.3 287.6H285.7c-59 0-106.8 47.8-106.8 106.8v303.1c0 59 
        47.8 106.8 106.8 106.8h81.5v111.1l166.9-110.6h160.9c59 0 
        106.8-47.8 106.8-106.8V394.5c0-59-47.8-106.9-106.8-106.9z"/>
      </svg>
      <div class="message-text">
        <div class="thinking-indicator">
          <div class="dot"></div>
          <div class="dot"></div>
          <div class="dot"></div>
        </div>
      </div>`,
      "bot-message",
      "thinking"
    );

    chatBody.appendChild(botMessage);
    chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: "smooth" });
    generateBotResponse(botMessage);
  }, 500);
};

// ===============================
// EVENTS
// ===============================
sendMessageButton.addEventListener("click", handleOutgoingMessage);

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) handleOutgoingMessage(e);
});

messageInput.addEventListener("input", () => {
  messageInput.style.height = `${initialInputHeight}px`;
  messageInput.style.height = `${messageInput.scrollHeight}px`;
});

// ===============================
// FILE UPLOAD
// ===============================
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    fileUploadWrapper.querySelector("img").src = e.target.result;
    fileUploadWrapper.classList.add("file-uplouded");
  };
  reader.readAsDataURL(file);
});

fileCancelButton.addEventListener("click", () => {
  fileUploadWrapper.classList.remove("file-uplouded");
});

// ===============================
// EMOJI PICKER
// ===============================
const picker = new EmojiMart.Picker({
  onEmojiSelect: (emoji) => {
    messageInput.value += emoji.native;
    messageInput.focus();
  },
});
document.querySelector(".chat-form").appendChild(picker);

// ===============================
// TOGGLE CHAT
// ===============================
chatbotToggler.addEventListener("click", () =>
  document.body.classList.toggle("show-chatbot")
);
closeChatbot.addEventListener("click", () =>
  document.body.classList.remove("show-chatbot")
);

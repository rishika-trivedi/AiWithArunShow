AI With Arun Show – AI Chatbot 🤖

An AI-powered chatbot built for the AI With Arun Show website using Google Gemini, with a secure Node.js backend and full production deployment.

🌐 Live: https://aiwitharunshow.com

---

##  Overview
This project integrates an AI chatbot directly into a public website. All AI requests are handled server-side to keep the API key secure, and the app is deployed with HTTPS and a custom domain.

---

##  Tech Stack
- **Frontend:** HTML, CSS, JavaScript  
- **Backend:** Node.js, Express  
- **AI:** Google Gemini  
- **Hosting:** Render  
- **Domain:** Namecheap  

---

##  Security
- API key stored in environment variables
- No secrets exposed to the frontend
- `.env` and `node_modules` excluded from version control

---

##  Structure
backend/ → Express server & API
public/ → Website + chatbot UI


---

## ▶️ Run Locally
bash
cd backend
npm install
npm start


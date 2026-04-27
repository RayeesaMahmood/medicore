const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Put your NEW Gemini API key here
const GEMINI_API_KEY = "AIzaSyDL4iIrhz-YhGOg6fmzlkHHBa28aivHbqg";

app.get("/", (req, res) => {
  res.send("Gemini backend is running on http://localhost:3000");
});

app.post("/api/claude", async (req, res) => {
  try {
    const userText =
      req.body.messages?.map(m => m.content).join("\n\n") ||
      "Analyze this hospital case.";

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: userText
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response from Gemini.";

    // Keep same Claude-like format so your frontend does not need changes
    res.json({
      content: [
        {
          text
        }
      ]
    });

  } catch (err) {
    res.status(500).json({
      error: "Gemini request failed",
      details: err.message
    });
  }
});

app.listen(3000, () => {
  console.log("Gemini backend running at http://localhost:3000");
});
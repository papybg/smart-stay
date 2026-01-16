// ... (началото на файла е същото)

app.post('/chat', async (req, res) => {
  const userMessage = req.body.message;
  let modelName = "gemini-3-flash-preview"; 
  let usedFallback = false;
  
  try {
    let model = genAI.getGenerativeModel({ 
      model: modelName, 
      systemInstruction: "Ти си Smart Stay Agent. Ако потребителят ти даде код (напр. TEST1), отговори само: CHECK_CODE: [кода]."
    });

    let result;
    try {
        result = await model.generateContent(userMessage);
    } catch (aiErr) {
        console.log("Gemini 3 е зает, превключвам на 1.5 Flash...");
        modelName = "gemini-1.5-flash";
        usedFallback = true;
        model = genAI.getGenerativeModel({ 
            model: modelName,
            systemInstruction: "Ти си Smart Stay Agent. Ако потребителят ти даде код (напр. TEST1), отговори само: CHECK_CODE: [кода]."
        });
        result = await model.generateContent(userMessage);
    }

    let botResponse = result.response.text().trim();

    if (botResponse.includes("CHECK_CODE:")) {
      const code = botResponse.split(":")[1].trim().replace("[", "").replace("]", "");
      const dbData = await checkBookingInDB(code);
      
      const finalModel = genAI.getGenerativeModel({ model: modelName });
      const finalResult = await finalModel.generateContent(`Данни: ${JSON.stringify(dbData)}. Отговори любезно на български дали резервацията е намерена и кажи ПИН кода само ако статусът е paid.`);
      
      botResponse = finalResult.response.text();
    }

    // Добавяме маркер за модела в края (само за тест)
    const debugInfo = usedFallback ? " (v1.5 ⚡)" : " (v3 ✨)";
    res.json({ reply: botResponse + debugInfo });

  } catch (err) {
    console.error("Критична AI Error:", err.message);
    res.status(500).json({ reply: "В момента системата е претоварена." });
  }
});

// ... (останалата част на файла е същата)
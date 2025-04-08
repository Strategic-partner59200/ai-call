import WebSocket from "ws";
import Twilio from "twilio";

export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const { 
    ELEVENLABS_API_KEY, 
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);


  
  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  // async function fetchElevenLabsPrompt() {
  //   try {
  //     const response = await fetch(
  //       `https://api.elevenlabs.io/v1/convai/conversation/get_prompt?agent_id=${ELEVENLABS_AGENT_ID}`,
  //       {
  //         method: 'GET',
  //         headers: {
  //           'xi-api-key': ELEVENLABS_API_KEY
  //         }
  //       }
  //     );
  //     console.log('Response:', response);

  //     if (!response.ok) {
  //       throw new Error(`Failed to get ElevenLabs prompt: ${response.statusText}`);
  //     }

  //     const data = await response.json();
  //     return data.prompt;
  //   } catch (error) {
  //     console.error("Error fetching ElevenLabs prompt:", error);
  //     return "Error fetching prompt.";
  //   }
  // }
  async function fetchElevenLabsPrompt() {
    try {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/convai/agents/${ELEVENLABS_AGENT_ID}`,
            {
                method: 'GET',
                headers: {
                    'xi-api-key': ELEVENLABS_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to get ElevenLabs prompt: ${response.statusText}`);
        }

        const data = await response.json();
        
        // Extract the prompt from the nested object
        const prompt = data?.conversation_config?.agent?.prompt?.prompt;
        
        if (!prompt) {
            throw new Error("Prompt not found in response");
        }
        
        return prompt;
    } catch (error) {
        console.error("Error fetching ElevenLabs prompt:", error);
        return "Error fetching prompt.";
    }
}

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?To=${encodeURIComponent(number)}`
    });

    reply.send({ 
      success: true, 
      message: "Call initiated", 
      callSid: call.sid 
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);
    reply.code(500).send({ 
      success: false, 
      error: "Failed to initiate call" 
    });
  }
});

  // TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const { To } = request.query; // Get the called number from Twilio
  
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
    <Connect>
      <Stream url="wss://${request.headers.host}/outbound-media-stream">
        <Parameter name="calledNumber" value="${To}" />
      </Stream>
    </Connect>
  </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      // Variables to track the call
      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;  // Add this to store parameters

      // Handle WebSocket errors
      ws.on('error', console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async (calledNumber) => {
        try {
          const elevenLabsPrompt = await fetchElevenLabsPrompt();
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: elevenLabsPrompt },
                  // first_message: "Bonjour, je suis Fridiric de Mon Réseau Habitat. Je vous appelle suite à la demande que vous avez faite pour obtenir des informations sur les aides de l'État pour la rénovation"
                },
              },
              dynamic_variables: {
                called_number: calledNumber  // Include the called number here
              }
            };
            console.log('[ElevenLabs] Initial config:', initialConfig);

            console.log("[ElevenLabs] Sending initial config with prompt:", initialConfig.conversation_config_override.agent.prompt.prompt);

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);
              console.log("[ElevenLabs] Received message:", message);
              if (message.audio?.chunk) {
                console.log("[ElevenLabs] Audio chunk received, size:", message.audio.chunk.length);
              } else {
                console.log("[ElevenLabs] No audio chunk in message");
              }

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;

                case "audio":
                  if (!streamSid) {
                    console.log("[ElevenLabs] StreamSid not available yet, buffering audio...");
                    return;
                  }
                  if (streamSid) {
                    if (message.audio?.chunk) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio.chunk,
                          content_type: "audio/x-mulaw; rate=8000",
                        }
                      };
                  
                      ws.send(JSON.stringify(audioData));
                    } else if (message.audio_event?.audio_base_64) {
                      const audioData = {
                        event: "media",
                        streamSid,
                        media: {
                          payload: message.audio_event.audio_base_64
                        }
                      };
                      ws.send(JSON.stringify(audioData));
                    }
                  } else {
                    console.log("[ElevenLabs] Received audio but no StreamSid yet");
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({ 
                      event: "clear",
                      streamSid 
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      // Set up ElevenLabs connection
      setupElevenLabs();

      // Handle messages from Twilio
      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log(`[Twilio] Received event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
  callSid = msg.start.callSid;
  customParameters = msg.start.customParameters;
  console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
  
  // Get the called number from custom parameters and pass to setupElevenLabs
  const calledNumber = customParameters?.calledNumber;
  if (calledNumber) {
    setupElevenLabs(calledNumber);
  } else {
    setupElevenLabs(); // Fallback if no number provided
  }
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });
  

      // Handle WebSocket closure
      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}
import WebSocket from "ws";
import Twilio from "twilio";
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage, ref, uploadString } from "firebase/storage";
import { stringify } from 'csv-stringify/sync';

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

// Helper function to generate CSV from conversation data
function generateConversationCSV(conversationData) {
  const columns = {
    timestamp: 'Timestamp',
    speaker: 'Speaker',
    messageType: 'Message Type',
    content: 'Content',
    sizeBytes: 'Size (bytes)',
    additionalInfo: 'Additional Info'
  };
  
  return stringify(conversationData, {
    header: true,
    columns: columns
  });
}

// Helper function to upload CSV to Firebase Storage
async function uploadConversationToStorage(callSid, csvData) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `conversations/${callSid}_${timestamp}.csv`;
    const storageRef = ref(storage, fileName);
    
    await uploadString(storageRef, csvData, 'raw', {
      contentType: 'text/csv'
    });
    
    console.log(`CSV file uploaded successfully: ${fileName}`);
    return fileName;
  } catch (error) {
    console.error('Error uploading conversation CSV:', error);
    throw error;
  }
}

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
        url: `https://${request.headers.host}/outbound-call-twiml`
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
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/outbound-media-stream" />
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
      let customParameters = null;
      let conversationData = [];

      // Handle WebSocket errors
      ws.on('error', console.error);

      // Set up ElevenLabs connection
      const setupElevenLabs = async () => {
        try {
          const elevenLabsPrompt = await fetchElevenLabsPrompt();
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            // Track the initial prompt
            conversationData.push({
              timestamp: new Date().toISOString(),
              speaker: 'System',
              messageType: 'Initialization',
              content: 'Conversation started with ElevenLabs',
              sizeBytes: elevenLabsPrompt.length,
              additionalInfo: JSON.stringify({
                agentId: ELEVENLABS_AGENT_ID
              })
            });

            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: { prompt: elevenLabsPrompt },
                },
              }
            };

            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);
              
              // Track ElevenLabs responses
              if (message.type === "audio" && message.audio?.chunk) {
                conversationData.push({
                  timestamp: new Date().toISOString(),
                  speaker: 'Bot',
                  messageType: 'Audio Response',
                  content: 'Audio chunk',
                  sizeBytes: message.audio.chunk.length,
                  additionalInfo: ''
                });
              }

              switch (message.type) {
                case "conversation_initiation_metadata":
                  break;

                case "audio":
                  if (streamSid) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                        content_type: "audio/x-mulaw; rate=8000",
                      }
                    };
                    ws.send(JSON.stringify(audioData));
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

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              
              // Track call start
              conversationData.push({
                timestamp: new Date().toISOString(),
                speaker: 'System',
                messageType: 'Call Start',
                content: 'Twilio stream connected',
                sizeBytes: 0,
                additionalInfo: JSON.stringify({
                  streamSid: streamSid,
                  callSid: callSid,
                  customParameters: customParameters
                })
              });
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
                
                // Track user audio
                conversationData.push({
                  timestamp: new Date().toISOString(),
                  speaker: 'User',
                  messageType: 'Audio Input',
                  content: 'User audio chunk',
                  sizeBytes: msg.media.payload.length,
                  additionalInfo: ''
                });
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              
              // Track call end
              conversationData.push({
                timestamp: new Date().toISOString(),
                speaker: 'System',
                messageType: 'Call End',
                content: 'Twilio stream disconnected',
                sizeBytes: 0,
                additionalInfo: ''
              });
              
              // Generate and upload CSV
              if (conversationData.length > 0) {
                try {
                  const csvData = generateConversationCSV(conversationData);
                  uploadConversationToStorage(callSid, csvData)
                    .then(fileName => {
                      console.log(`Conversation saved to ${fileName}`);
                    })
                    .catch(error => {
                      console.error('Failed to save conversation:', error);
                    });
                } catch (error) {
                  console.error('Error generating conversation CSV:', error);
                }
              }
              
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
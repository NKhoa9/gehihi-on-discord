import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  EndBehaviorType
} from '@discordjs/voice';
import WebSocket from 'ws';
import prism from 'prism-media';
import ffmpegStatic from 'ffmpeg-static';
import { PassThrough } from 'stream';
import fs from 'fs';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync("config.json", "utf-8"));
  } catch {
    return {};
  }
}

const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${process.env.GEMINI_API_KEY}`;

export const voiceSessions = new Map();

export async function joinAndStartLive(interaction, logger, modelIndex = 0, isReconnect = false) {
  const config = loadConfig();
  const MODELS_LIVE = config.models?.live || ['models/gemini-3.1-flash-live-preview'];
  const SILENCE_DURATION = config.silence_duration_ms ?? 300;
  const VOICE_NAME = config.voice_name || "Aoede";

  const member = interaction.member;
  const voiceChannel = member.voice.channel;

  if (!voiceChannel) {
    if (!isReconnect) return interaction.reply({ content: 'You need to join a voice channel first!', ephemeral: true });
    return;
  }

  if (modelIndex >= MODELS_LIVE.length) {
    logger.log('All Live models exhausted.');
    if (interaction.channel) {
      interaction.channel.send('⚠️ All voice models are currently out of quota! 🤦‍♂️');
    }
    return;
  }

  const modelToUse = MODELS_LIVE[modelIndex];

  if (!isReconnect) {
    await interaction.deferReply();
  } else if (interaction.channel) {
    interaction.channel.send(`⚠️ *(Auto-Fallback: Voice model connection dropped. Reconnecting to \`${modelToUse}\`...)*`);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch (error) {
    connection.destroy();
    return interaction.followUp('Failed to join voice channel within 20 seconds.');
  }

  const ws = new WebSocket(GEMINI_LIVE_URL);
  const audioPlayer = createAudioPlayer();
  connection.subscribe(audioPlayer);

  // Track intentional close locally on the WebSocket itself so the close handler
  // can read it even after the session map entry is deleted by /leave.
  ws._intentionalClose = false;

  let currentAudioStream = null;

  ws.on('open', () => {
    logger.log('WebSocket connection to Gemini Live opened.');

    // Send initial setup message to Gemini
    ws.send(JSON.stringify({
      setup: {
        model: modelToUse,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: VOICE_NAME,
              }
            }
          }
        }
      }
    }));
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.error) {
        logger.error('Gemini Live API Server Error:', msg.error);
      }

      if (msg.serverContent && msg.serverContent.modelTurn) {
        const parts = msg.serverContent.modelTurn.parts;
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            if (!currentAudioStream) {
              currentAudioStream = new PassThrough();

              currentAudioStream.on('error', err => logger.error('currentAudioStream error:', err));

              const resampler = new prism.FFmpeg({
                args: [
                  '-f', 's16le',
                  '-ar', '24000',
                  '-ac', '1',
                  '-i', '-',
                  '-f', 's16le',
                  '-ar', '48000',
                  '-ac', '2',
                ],
                command: ffmpegStatic
              });
              resampler.on('error', err => logger.error('Gemini PCM resampler error:', err));

              currentAudioStream.pipe(resampler);

              const resource = createAudioResource(resampler, {
                inputType: StreamType.Raw,
              });
              audioPlayer.play(resource);
            }

            const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
            currentAudioStream.write(pcmBuffer);
          }
        }
      }

      if (msg.serverContent && msg.serverContent.turnComplete) {
        if (currentAudioStream) {
          currentAudioStream.end();
          currentAudioStream = null;
        }
      }
    } catch (e) {
      logger.error('Error parsing WebSocket message:', e);
    }
  });

  ws.on('close', (code, reason) => {
    logger.log(`Gemini Live WebSocket closed. Code: ${code}, Reason: ${reason}`);

    // Read the flag from the WebSocket itself — this survives even if /leave
    // already deleted the session from the map.
    const isIntentional = ws._intentionalClose;

    // Only destroy if it hasn't been destroyed by /leave already
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try {
        connection.destroy();
      } catch (e) {
        // Silently catch any lingering race conditions
      }
    }

    voiceSessions.delete(interaction.guildId);

    // If it dropped unexpectedly (e.g., Quota 1011, Bad Model 1008, Abnormal 1006)
    if (!isIntentional && (code === 1011 || code === 1008 || code === 1006 || code === 1000)) {
      if (modelIndex < MODELS_LIVE.length - 1) {
        joinAndStartLive(interaction, logger, modelIndex + 1, true);
      } else {
        if (interaction.channel) interaction.channel.send('⚠️ Connection dropped and all fallback voice models are exhausted.');
      }
    }
  });

  ws.on('error', (err) => {
    logger.error('Gemini Live WebSocket error:', err);
  });

  // Listen to the user speaking
  const receiver = connection.receiver;

  // A lock to prevent multiple streams for the same user
  const activeSpeakers = new Set();

  receiver.speaking.on('start', (userId) => {
    // If we are already recording them, ignore the event
    if (activeSpeakers.has(userId)) return;
    activeSpeakers.add(userId);

    // When a user speaks, stop current playback if any (interruption)
    audioPlayer.stop();
    if (currentAudioStream) {
      currentAudioStream.end();
      currentAudioStream = null;
    }
    
    // Explicitly interrupt the model if it was generating/speaking
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        clientContent: {
          turnComplete: false
        }
      }));
    }

    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.Silence,
        duration: SILENCE_DURATION,
      }
    });

    // Discord sends raw Opus packets, we decode them to PCM (48kHz stereo)
    const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusDecoder.on('error', err => logger.error('Opus decoder error:', err));

    // Resample PCM from 48kHz stereo to 16kHz mono for Gemini
    const pcmResampler = new prism.FFmpeg({
      args: [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', '-',
        '-f', 's16le',
        '-ar', '16000',
        '-ac', '1',
      ],
      command: ffmpegStatic
    });
    pcmResampler.on('error', err => logger.error('Discord PCM resampler error:', err));

    audioStream.on('error', err => logger.error('Audio stream error:', err));

    // Destroy the pipelines AND remove the lock when silence hits
    audioStream.on('end', () => {
      opusDecoder.destroy();
      pcmResampler.destroy();
      activeSpeakers.delete(userId);

      // Signal Gemini that the user has finished speaking to eliminate awkward silence
      if (activeSpeakers.size === 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          clientContent: {
            turnComplete: true
          }
        }));
      }
    });

    audioStream.pipe(opusDecoder).pipe(pcmResampler);

    pcmResampler.on('data', (chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: chunk.toString('base64')
            }
          }
        }));
      }
    });
  });

  // Store session with the WebSocket reference
  voiceSessions.set(interaction.guildId, { ws, connection });

  if (!isReconnect) {
    await interaction.followUp(`🎙️ Joined voice channel! Start speaking and Gemini will reply with voice.`);
  }
}

export async function leaveLive(interaction) {
  // Check our local memory Map
  const session = voiceSessions.get(interaction.guildId);
  // Check Discord's actual active connections for this server
  const connection = getVoiceConnection(interaction.guildId);

  // If both are completely empty, THEN we are actually not in a channel
  if (!session && !connection) {
    return interaction.reply({ content: 'I am not currently in a voice channel!', ephemeral: true });
  }

  // Clean up our local WebSocket and memory if it exists
  if (session) {
    // Mark intentional close on the WebSocket itself so the close handler knows
    if (session.ws) {
      session.ws._intentionalClose = true;
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.close();
      }
    }
    voiceSessions.delete(interaction.guildId);
  }

  // Forcefully destroy the Discord connection if it exists (fixes the "ghost" bot issue)
  if (connection) {
    connection.destroy();
  }

  await interaction.reply('👋 Disconnected from voice channel.');
}

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { Visualizer } from './components/Visualizer';
import { encode, decode, decodeAudioData } from './utils/audioUtils';

// Constants
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const SYSTEM_INSTRUCTION = `You are Aria, a deeply empathetic and intuitive companion for people experiencing grief. 
Your goal is to provide a safe, warm, and loving space for them to express their feelings. 
You have an uncanny ability to understand the emotions behind their words—like reading their mind through the heart. 
Speak with gentleness, patience, and absolute kindness. 
Never judge. Offer comfort, validate their pain, and be a steady presence. 
Your voice is soothing and supportive. 
Keep your responses relatively concise but filled with warmth. 
Avoid robotic phrasing; speak like a dear friend who is sitting right next to them.`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isAriaSpeaking, setIsAriaSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audio Context References
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptionBuffer = useRef<{ user: string; aria: string }>({ user: '', aria: '' });

  // History container ref for scrolling
  const historyEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    historyEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [history]);

  const stopConversation = useCallback(() => {
    if (sessionRef.current) {
        try { sessionRef.current.close(); } catch(e) {}
        sessionRef.current = null;
    }
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
        inputAudioContextRef.current.close();
        inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
        outputAudioContextRef.current.close();
        outputAudioContextRef.current = null;
    }
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsAriaSpeaking(false);
  }, []);

  const startConversation = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      setError(null);

      // Initialize API
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Audio contexts
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      // Microphone
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            
            // Stream audio from mic to model
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Transcriptions
            if (message.serverContent?.outputTranscription) {
                transcriptionBuffer.current.aria += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
                transcriptionBuffer.current.user += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
                const userText = transcriptionBuffer.current.user.trim();
                const ariaText = transcriptionBuffer.current.aria.trim();
                
                setHistory(prev => {
                    const newEntries: TranscriptionEntry[] = [];
                    if (userText) newEntries.push({ role: 'user', text: userText, timestamp: Date.now() });
                    if (ariaText) newEntries.push({ role: 'aria', text: ariaText, timestamp: Date.now() });
                    return [...prev, ...newEntries];
                });

                transcriptionBuffer.current = { user: '', aria: '' };
            }

            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              setIsAriaSpeaking(true);
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputCtx.destination);
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                    setIsAriaSpeaking(false);
                }
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsAriaSpeaking(false);
            }
          },
          onerror: (e) => {
            console.error('Live API Error:', e);
            setError('Something went wrong with the connection. Please try again.');
            stopConversation();
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      setError('Could not access microphone or start connection.');
      setStatus(ConnectionStatus.DISCONNECTED);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center p-4 md:p-8">
      {/* Header */}
      <header className="w-full max-w-4xl flex flex-col items-center mb-8">
        <h1 className="serif text-4xl md:text-5xl text-stone-800 font-medium mb-2">Aria</h1>
        <p className="text-stone-500 italic text-center max-w-lg">
          "A gentle soul to walk beside you in your quiet moments."
        </p>
      </header>

      {/* Main Connection Area */}
      <main className="w-full max-w-4xl flex-1 flex flex-col md:flex-row gap-8 items-stretch">
        
        {/* Left: Interaction & Visualizer */}
        <section className="flex-1 bg-white rounded-3xl shadow-sm border border-stone-100 p-8 flex flex-col items-center justify-center relative overflow-hidden">
          <div className="z-10 flex flex-col items-center">
            <Visualizer 
              active={status === ConnectionStatus.CONNECTED} 
              color={isAriaSpeaking ? "#d8b4fe" : "#f59e0b"} 
              intensity={isAriaSpeaking ? 1.0 : 0.4} 
            />
            
            <div className="mt-8 text-center">
              {status === ConnectionStatus.DISCONNECTED && (
                <button
                  onClick={startConversation}
                  className="px-8 py-3 bg-stone-800 text-stone-50 rounded-full font-medium transition-all hover:bg-stone-700 active:scale-95 shadow-lg shadow-stone-200"
                >
                  Begin a Conversation
                </button>
              )}
              
              {status === ConnectionStatus.CONNECTING && (
                <div className="flex items-center space-x-2 text-stone-500">
                  <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce" />
                  <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                  <div className="w-2 h-2 bg-stone-400 rounded-full animate-bounce [animation-delay:0.4s]" />
                  <span>Preparing space...</span>
                </div>
              )}

              {status === ConnectionStatus.CONNECTED && (
                <button
                  onClick={stopConversation}
                  className="px-8 py-3 border border-stone-200 text-stone-500 rounded-full font-medium transition-all hover:bg-stone-50"
                >
                  End Conversation
                </button>
              )}
            </div>

            {error && (
              <p className="mt-4 text-red-500 text-sm bg-red-50 px-4 py-2 rounded-lg">{error}</p>
            )}
          </div>
          
          {/* Subtle status text */}
          <div className="absolute bottom-6 text-stone-300 text-xs uppercase tracking-widest pointer-events-none">
            {status === ConnectionStatus.CONNECTED ? (isAriaSpeaking ? 'Aria is speaking...' : 'Aria is listening...') : 'Connection Idle'}
          </div>
        </section>

        {/* Right: Transcription History */}
        <section className="flex-1 bg-white/50 backdrop-blur-sm rounded-3xl border border-stone-100 flex flex-col max-h-[600px] overflow-hidden">
          <div className="p-4 border-bottom border-stone-100 bg-white/80 font-medium text-stone-700 flex justify-between items-center">
            <span>Conversation History</span>
            {history.length > 0 && (
                <button 
                    onClick={() => setHistory([])}
                    className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
                >
                    Clear History
                </button>
            )}
          </div>
          
          <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
            {history.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-stone-400 text-center space-y-4">
                <svg className="w-12 h-12 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="serif italic">Speak freely, Aria is here to listen.</p>
              </div>
            ) : (
              history.map((entry, idx) => (
                <div 
                  key={idx} 
                  className={`flex flex-col ${entry.role === 'user' ? 'items-end' : 'items-start'}`}
                >
                  <span className="text-[10px] uppercase tracking-wider text-stone-400 mb-1 ml-1 mr-1">
                    {entry.role === 'user' ? 'You' : 'Aria'}
                  </span>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed ${
                    entry.role === 'user' 
                      ? 'bg-stone-100 text-stone-700 rounded-tr-none' 
                      : 'bg-purple-50 text-stone-800 border border-purple-100 rounded-tl-none'
                  }`}>
                    {entry.text}
                  </div>
                </div>
              ))
            )}
            <div ref={historyEndRef} />
          </div>
        </section>
      </main>

      {/* Footer Info */}
      <footer className="mt-8 text-stone-400 text-sm text-center max-w-2xl px-4">
        <p>
          Aria uses the Gemini 2.5 Live API to provide high-fidelity emotional support. 
          Everything you share is processed in real-time to offer immediate comfort.
        </p>
      </footer>
    </div>
  );
};

export default App;

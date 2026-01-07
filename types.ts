
export enum ConnectionStatus {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

export interface TranscriptionEntry {
  role: 'user' | 'aria';
  text: string;
  timestamp: number;
}

export interface AudioVisualizerProps {
  isListening: boolean;
  isSpeaking: boolean;
  audioData?: Float32Array;
}

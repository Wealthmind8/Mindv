
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  active: boolean;
  color: string;
  intensity: number; // 0 to 1
}

export const Visualizer: React.FC<VisualizerProps> = ({ active, color, intensity }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let time = 0;

    const render = () => {
      time += 0.02;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const baseRadius = Math.min(centerX, centerY) * 0.4;
      
      // Draw multiple layers of soft glowing circles
      for (let i = 0; i < 3; i++) {
        const pulse = active ? Math.sin(time + i) * 10 * intensity : 0;
        const radius = baseRadius + pulse + (i * 15);
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.2 / (i + 1);
        ctx.stroke();
        
        if (i === 0) {
            ctx.fillStyle = color;
            ctx.globalAlpha = active ? 0.3 * intensity : 0.1;
            ctx.fill();
        }
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [active, color, intensity]);

  return (
    <canvas 
      ref={canvasRef} 
      width={300} 
      height={300} 
      className="max-w-full h-auto"
    />
  );
};

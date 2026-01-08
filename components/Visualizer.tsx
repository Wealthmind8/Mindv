
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  active: boolean;
  color: string;
  intensity: number; // 0 to 2 for high dynamic range
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
      time += 0.015;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const baseRadius = Math.min(centerX, centerY) * 0.45;
      
      // Draw 5 layers of sophisticated neural pulses
      for (let i = 0; i < 5; i++) {
        const pulseFactor = active ? Math.sin(time * 1.5 + i * 0.5) * 15 * intensity : 0;
        const radius = baseRadius + pulseFactor + (i * 20);
        
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        
        // Gradient stroke for a more premium look
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, i % 2 === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(99,102,241,0.5)');
        
        ctx.strokeStyle = gradient;
        ctx.lineWidth = i === 0 ? 3 : 1;
        ctx.globalAlpha = (active ? 0.35 : 0.1) / (i + 1);
        ctx.stroke();
        
        // Inner core glow
        if (i === 0) {
            ctx.shadowBlur = active ? 40 * intensity : 10;
            ctx.shadowColor = color;
            ctx.fillStyle = color;
            ctx.globalAlpha = active ? 0.4 * intensity : 0.15;
            ctx.fill();
            ctx.shadowBlur = 0; // Reset for other layers
        }

        // Add small particles circling the core
        if (active && i > 0 && i < 3) {
            const particleCount = 3;
            for (let p = 0; p < particleCount; p++) {
                const angle = time + (p * Math.PI * 2 / particleCount) + (i * 1.2);
                const px = centerX + Math.cos(angle) * radius;
                const py = centerY + Math.sin(angle) * radius;
                ctx.beginPath();
                ctx.arc(px, py, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#fff';
                ctx.globalAlpha = 0.4;
                ctx.fill();
            }
        }
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [active, color, intensity]);

  return (
    <div className="relative flex items-center justify-center">
        {/* Subtle background pulse for extra depth */}
        <div className={`absolute w-full h-full rounded-full transition-all duration-1000 blur-3xl ${active ? 'bg-indigo-500/10 scale-125' : 'bg-transparent scale-100'}`} />
        <canvas 
            ref={canvasRef} 
            width={400} 
            height={400} 
            className="max-w-full h-auto z-10"
        />
    </div>
  );
};

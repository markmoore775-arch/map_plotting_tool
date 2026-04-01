import React, { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Trophy, Map, ArrowLeft } from 'lucide-react';

// --- Game Constants ---
const FLOOR_Y = 640;
const CEILING_Y = 80;
const GRAVITY = 0.5;
const THRUST = 0.9;
const MAX_VELOCITY = 12;
const OBSTACLE_SPEED = 8;
const DRONE_SIZE = 40;
/** Spawn / rest position: center Y just above the floor (side-scroller “start at bottom”). */
const DRONE_START_Y = FLOOR_Y - DRONE_SIZE / 2 - 8;
/** Fixed sim step so gameplay speed is stable when rAF is throttled (e.g. mobile without touch). */
const SIM_DT = 1 / 60;
const MAX_SIM_STEPS_PER_FRAME = 5;

const DRONE_DASH_BGM_URL = `${import.meta.env.BASE_URL}music/drone-dash.mp3`;

const THEMES = [
  {
    name: 'Cyber City',
    bg: '#0f172a', // slate-900
    floor: '#020617', // slate-950
    accent: '#22d3ee', // cyan-400
    obsColor: '#f43f5e', // rose-500
    bgType: 'city',
    obsType: 'laser'
  },
  {
    name: 'Suburban Dusk',
    bg: '#2e1065', // purple-900
    floor: '#172554', // blue-950
    accent: '#f59e0b', // amber-500
    obsColor: '#10b981', // emerald-500
    bgType: 'suburb',
    obsType: 'structure'
  },
  {
    name: 'Rural Night',
    bg: '#064e3b', // emerald-900
    floor: '#022c22', // emerald-950
    accent: '#a3e635', // lime-400
    obsColor: '#eab308', // yellow-500
    bgType: 'rural',
    obsType: 'nature'
  }
];

// --- Types ---
type GameState = 'start' | 'countdown' | 'playing' | 'gameover';

interface Drone {
  x: number;
  y: number;
  vy: number;
  rotation: number;
}

interface Obstacle {
  x: number;
  y: number;
  width: number;
  height: number;
  passed: boolean;
  type: 'top' | 'bottom' | 'floating';
  vy: number;
  minY: number;
  maxY: number;
  themeType: string;
  color: string;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

interface BgElement {
  x: number;
  width: number;
  height: number;
  speed: number;
  themeType: string;
  color: string;
  seed: number;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<GameState>('start');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [currentThemeName, setCurrentThemeName] = useState(THEMES[0].name);

  const [dimensions, setDimensions] = useState({ width: 1280, height: 720 });
  const [isPortrait, setIsPortrait] = useState(false);
  const [countdownLabel, setCountdownLabel] = useState<'3' | '2' | '1' | 'go'>('3');
  const [countdownEpoch, setCountdownEpoch] = useState(0);
  const dimRef = useRef({ width: 1280, height: 720 });
  const countdownTokenRef = useRef(0);

  // Mutable game state refs
  const stateRef = useRef({
    gameState: 'start' as GameState,
    score: 0,
    frames: 0,
    isThrusting: false,
    themeIndex: 0,
  });

  const droneRef = useRef<Drone>({
    x: 200,
    y: DRONE_START_Y,
    vy: 0,
    rotation: 0,
  });

  const obstaclesRef = useRef<Obstacle[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const bgElementsRef = useRef<BgElement[]>([]);
  const animationFrameId = useRef<number>(0);
  const lastLoopTimeRef = useRef<number | null>(null);
  const simAccumulatorRef = useRef(0);
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);

  // --- Input Handling ---
  const handleThrustStart = (e?: React.SyntheticEvent | KeyboardEvent) => {
    if (e && 'code' in e && e.code !== 'Space') return;
    if (e) e.preventDefault();

    if (stateRef.current.gameState === 'countdown') return;

    if (stateRef.current.gameState === 'start' || stateRef.current.gameState === 'gameover') {
      beginCountdown();
      return;
    }
    stateRef.current.isThrusting = true;
  };

  const handleThrustEnd = (e?: React.SyntheticEvent | KeyboardEvent) => {
    if (e && 'code' in e && e.code !== 'Space') return;
    if (e) e.preventDefault();
    stateRef.current.isThrusting = false;
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => handleThrustStart(e);
    const handleKeyUp = (e: KeyboardEvent) => handleThrustEnd(e);

    const handleResize = () => {
      const isPort = window.innerHeight > window.innerWidth;
      setIsPortrait(isPort);

      const aspect = window.innerWidth / window.innerHeight;
      const newWidth = Math.max(720 * aspect, 720);

      dimRef.current = {
        width: newWidth,
        height: 720,
      };
      setDimensions(dimRef.current);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', () => setTimeout(handleResize, 100));
    window.addEventListener('keydown', handleKeyDown, { passive: false });
    window.addEventListener('keyup', handleKeyUp, { passive: false });

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // --- Game Logic ---
  const requestFullscreen = async () => {
    try {
      const docEl = document.documentElement as any;
      if (docEl.requestFullscreen) {
        await docEl.requestFullscreen();
      } else if (docEl.webkitRequestFullscreen) {
        await docEl.webkitRequestFullscreen();
      }
      
      const screenOrientation = screen.orientation as any;
      if (screenOrientation && screenOrientation.lock) {
        await screenOrientation.lock('landscape');
      }
    } catch (err) {
      console.log('Fullscreen/Orientation lock failed:', err);
    }
  };

  const gameOver = () => {
    stateRef.current.gameState = 'gameover';
    stateRef.current.isThrusting = false;
    setGameState('gameover');
    setHighScore((prev) => Math.max(prev, stateRef.current.score));
    
    const d = droneRef.current;
    for (let i = 0; i < 50; i++) {
      particlesRef.current.push({
        x: d.x,
        y: d.y,
        vx: (Math.random() - 0.5) * 15,
        vy: (Math.random() - 0.5) * 15,
        life: 1,
        maxLife: Math.random() * 30 + 20,
        color: Math.random() > 0.5 ? THEMES[stateRef.current.themeIndex].accent : THEMES[stateRef.current.themeIndex].obsColor,
        size: Math.random() * 6 + 2,
      });
    }
  };

  const spawnBgElement = (startX?: number) => {
    const start = startX !== undefined ? startX : dimRef.current.width;
    const theme = THEMES[stateRef.current.themeIndex];
    let width = 0, height = 0, speed = 0, color = '';
    
    if (theme.bgType === 'city') {
      width = 60 + Math.random() * 80;
      height = 100 + Math.random() * 300;
      speed = 1 + Math.random() * 1.5;
      color = Math.random() > 0.5 ? '#1e293b' : '#334155';
    } else if (theme.bgType === 'suburb') {
      width = 80 + Math.random() * 40;
      height = 60 + Math.random() * 60;
      speed = 1.5 + Math.random() * 1;
      color = Math.random() > 0.5 ? '#4c1d95' : '#5b21b6';
    } else if (theme.bgType === 'rural') {
      width = 100 + Math.random() * 150;
      height = 80 + Math.random() * 150;
      speed = 0.5 + Math.random() * 1;
      color = Math.random() > 0.5 ? '#065f46' : '#047857';
    }

    bgElementsRef.current.push({
      x: start,
      width,
      height,
      speed,
      themeType: theme.bgType,
      color,
      seed: Math.random()
    });
  };

  const beginCountdown = () => {
    requestFullscreen();
    droneRef.current = { x: 200, y: DRONE_START_Y, vy: 0, rotation: 0 };
    stateRef.current = {
      ...stateRef.current,
      gameState: 'countdown',
      isThrusting: false,
    };
    setCountdownLabel('3');
    setCountdownEpoch((n) => n + 1);
    setGameState('countdown');
    if (!bgMusicRef.current) {
      const a = new Audio(DRONE_DASH_BGM_URL);
      a.loop = true;
      a.volume = 0.45;
      bgMusicRef.current = a;
    }
    const bg = bgMusicRef.current;
    bg.currentTime = 0;
    void bg.play().catch(() => {});
  };

  const startGameActual = () => {
    requestFullscreen();
    stateRef.current = {
      gameState: 'playing',
      score: 0,
      frames: 0,
      isThrusting: false,
      themeIndex: 0,
    };
    droneRef.current = {
      x: 200,
      y: DRONE_START_Y,
      vy: 0,
      rotation: 0,
    };
    obstaclesRef.current = [];
    particlesRef.current = [];
    bgElementsRef.current = [];

    for (let i = 0; i < 10; i++) {
      spawnBgElement(dimRef.current.width * (i / 10));
    }

    setGameState('playing');
    setScore(0);
    setCurrentThemeName(THEMES[0].name);
  };

  useEffect(() => {
    if (gameState !== 'countdown') return;
    const sessionId = ++countdownTokenRef.current;
    let cancelled = false;
    const steps: { label: '3' | '2' | '1' | 'go'; ms: number }[] = [
      { label: '3', ms: 1000 },
      { label: '2', ms: 1000 },
      { label: '1', ms: 1000 },
      { label: 'go', ms: 700 },
    ];

    const run = async () => {
      for (const step of steps) {
        if (cancelled || sessionId !== countdownTokenRef.current) return;
        setCountdownLabel(step.label);
        await new Promise((r) => setTimeout(r, step.ms));
        if (cancelled || sessionId !== countdownTokenRef.current) return;
      }
      if (cancelled || sessionId !== countdownTokenRef.current) return;
      startGameActual();
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [gameState, countdownEpoch]);

  useEffect(() => {
    if (gameState !== 'gameover') return;
    bgMusicRef.current?.pause();
  }, [gameState]);

  useEffect(() => {
    return () => {
      const a = bgMusicRef.current;
      if (a) {
        a.pause();
        bgMusicRef.current = null;
      }
    };
  }, []);

  const spawnObstacle = () => {
    const theme = THEMES[stateRef.current.themeIndex];
    const gap = 220 - Math.min(stateRef.current.score, 100); // Gap shrinks slightly as score goes up
    const minHeight = 50;
    const maxHeight = 720 - CEILING_Y - (720 - FLOOR_Y) - gap - minHeight;
    
    const typeRoll = Math.random();
    let type: 'top' | 'bottom' | 'floating' = 'bottom';
    let y = 0;
    let height = 0;
    let vy = 0;
    let minY = CEILING_Y;
    let maxY = FLOOR_Y;

    if (typeRoll < 0.35) {
      type = 'bottom';
      height = Math.random() * maxHeight + minHeight;
      y = FLOOR_Y - height;
    } else if (typeRoll < 0.7) {
      type = 'top';
      height = Math.random() * maxHeight + minHeight;
      y = CEILING_Y;
    } else {
      type = 'floating';
      height = 100 + Math.random() * 60;
      y = Math.random() * (FLOOR_Y - CEILING_Y - height) + CEILING_Y;
      
      // 40% chance for floating obstacles to move
      if (Math.random() > 0.6) {
        vy = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2);
        minY = CEILING_Y + 10;
        maxY = FLOOR_Y - 10;
      }
    }

    obstaclesRef.current.push({
      x: dimRef.current.width,
      y,
      width: 80,
      height,
      passed: false,
      type,
      vy,
      minY,
      maxY,
      themeType: theme.obsType,
      color: theme.obsColor
    });
  };

  const spawnThrustParticles = () => {
    const d = droneRef.current;
    const theme = THEMES[stateRef.current.themeIndex];
    particlesRef.current.push({
      x: d.x - 15,
      y: d.y + 10,
      vx: -OBSTACLE_SPEED + (Math.random() - 0.5) * 2,
      vy: Math.random() * 3 + 2,
      life: 1,
      maxLife: 15 + Math.random() * 10,
      color: theme.accent,
      size: Math.random() * 4 + 2,
    });
  };

  // --- Main Game Loop ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const updateParticles = () => {
      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life++;
        if (p.life >= p.maxLife) {
          particles.splice(i, 1);
        }
      }
    };

    /** One fixed 1/60s simulation step (decoupled from rAF rate for stable speed on mobile). */
    const advancePlayingTick = () => {
      const state = stateRef.current;
      if (state.gameState !== 'playing') return;

      const drone = droneRef.current;
      const obstacles = obstaclesRef.current;
      const bgElements = bgElementsRef.current;

      state.frames++;

      if (state.isThrusting) {
        drone.vy -= THRUST;
        spawnThrustParticles();
      }
      drone.vy += GRAVITY;

      if (drone.vy > MAX_VELOCITY) drone.vy = MAX_VELOCITY;
      if (drone.vy < -MAX_VELOCITY) drone.vy = -MAX_VELOCITY;

      drone.y += drone.vy;

      const targetRotation = Math.min(Math.max(drone.vy * 0.05, -0.5), 0.5);
      drone.rotation += (targetRotation - drone.rotation) * 0.1;

      if (drone.y + DRONE_SIZE / 2 > FLOOR_Y) {
        drone.y = FLOOR_Y - DRONE_SIZE / 2;
        drone.vy = 0;
      }
      if (drone.y - DRONE_SIZE / 2 < CEILING_Y) {
        drone.y = CEILING_Y + DRONE_SIZE / 2;
        drone.vy = 0;
      }

      if (state.frames % 40 === 0) {
        spawnBgElement();
      }
      for (let i = bgElements.length - 1; i >= 0; i--) {
        bgElements[i].x -= bgElements[i].speed;
        if (bgElements[i].x + bgElements[i].width < 0) {
          bgElements.splice(i, 1);
        }
      }

      const spawnRate = Math.max(40, 70 - Math.floor(state.score / 50));
      if (state.frames % spawnRate === 0) {
        spawnObstacle();
      }

      for (let i = obstacles.length - 1; i >= 0; i--) {
        const obs = obstacles[i];
        obs.x -= OBSTACLE_SPEED;

        if (obs.vy !== 0) {
          obs.y += obs.vy;
          if (obs.y <= obs.minY || obs.y + obs.height >= obs.maxY) {
            obs.vy *= -1;
          }
        }

        const margin = 8;
        if (
          drone.x + DRONE_SIZE / 2 - margin > obs.x &&
          drone.x - DRONE_SIZE / 2 + margin < obs.x + obs.width &&
          drone.y + DRONE_SIZE / 2 - margin > obs.y &&
          drone.y - DRONE_SIZE / 2 + margin < obs.y + obs.height
        ) {
          gameOver();
        }

        if (!obs.passed && drone.x > obs.x + obs.width) {
          obs.passed = true;
          state.score += 10;
          setScore(state.score);
        }

        if (obs.x + obs.width < 0) {
          obstacles.splice(i, 1);
        }
      }

      updateParticles();
    };

    const loop = (now: number) => {
      const state = stateRef.current;

      // Theme Progression (Change every 150 points)
      const newThemeIndex = Math.floor(state.score / 150) % THEMES.length;
      if (newThemeIndex !== state.themeIndex && state.gameState === 'playing') {
        state.themeIndex = newThemeIndex;
        setCurrentThemeName(THEMES[newThemeIndex].name);
      }
      const currentTheme = THEMES[state.themeIndex];

      if (lastLoopTimeRef.current === null) {
        lastLoopTimeRef.current = now;
      }
      let frameDt = (now - lastLoopTimeRef.current) / 1000;
      lastLoopTimeRef.current = now;
      frameDt = Math.min(frameDt, 0.25);

      if (state.gameState === 'playing') {
        simAccumulatorRef.current += frameDt;
        let steps = 0;
        while (simAccumulatorRef.current >= SIM_DT && steps < MAX_SIM_STEPS_PER_FRAME) {
          advancePlayingTick();
          simAccumulatorRef.current -= SIM_DT;
          steps++;
        }
      } else {
        simAccumulatorRef.current = 0;
        updateParticles();
      }

      const bgElements = bgElementsRef.current;
      const obstacles = obstaclesRef.current;
      const particles = particlesRef.current;
      const drone = droneRef.current;

      // --- Draw Phase ---
      // 1. Background Fill
      ctx.fillStyle = currentTheme.bg;
      ctx.fillRect(0, 0, dimRef.current.width, dimRef.current.height);

      // 2. Parallax Background Elements
      bgElements.forEach(bg => {
        ctx.fillStyle = bg.color;
        if (bg.themeType === 'city') {
          ctx.fillRect(bg.x, FLOOR_Y - bg.height, bg.width, bg.height);
          // Windows
          ctx.fillStyle = '#fbbf24'; // yellow-400
          ctx.globalAlpha = 0.3;
          const cols = Math.floor(bg.width / 20);
          const rows = Math.floor(bg.height / 30);
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
              // Deterministic window pattern based on seed
              if ((bg.seed * 100 + c * 7 + r * 13) % 2 > 0.5) {
                ctx.fillRect(bg.x + 10 + c * 20, FLOOR_Y - bg.height + 10 + r * 30, 8, 15);
              }
            }
          }
          ctx.globalAlpha = 1.0;
        } else if (bg.themeType === 'suburb') {
          // House body
          ctx.fillRect(bg.x, FLOOR_Y - bg.height, bg.width, bg.height);
          // Roof
          ctx.beginPath();
          ctx.moveTo(bg.x - 10, FLOOR_Y - bg.height);
          ctx.lineTo(bg.x + bg.width / 2, FLOOR_Y - bg.height - 30);
          ctx.lineTo(bg.x + bg.width + 10, FLOOR_Y - bg.height);
          ctx.fill();
        } else if (bg.themeType === 'rural') {
          // Pine trees / Hills
          ctx.beginPath();
          ctx.moveTo(bg.x, FLOOR_Y);
          ctx.lineTo(bg.x + bg.width / 2, FLOOR_Y - bg.height);
          ctx.lineTo(bg.x + bg.width, FLOOR_Y);
          ctx.fill();
        }
      });

      // 3. Ceiling and Floor
      ctx.fillStyle = currentTheme.floor;
      ctx.fillRect(0, 0, dimRef.current.width, CEILING_Y);
      ctx.fillRect(0, FLOOR_Y, dimRef.current.width, dimRef.current.height - FLOOR_Y);
      
      // Neon borders
      ctx.shadowBlur = 15;
      ctx.shadowColor = currentTheme.accent;
      ctx.strokeStyle = currentTheme.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, CEILING_Y);
      ctx.lineTo(dimRef.current.width, CEILING_Y);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(0, FLOOR_Y);
      ctx.lineTo(dimRef.current.width, FLOOR_Y);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 4. Obstacles
      obstacles.forEach((obs) => {
        if (obs.themeType === 'laser') {
          // Cyberpunk Laser Gate
          ctx.fillStyle = '#111827';
          ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
          
          ctx.strokeStyle = obs.color;
          ctx.lineWidth = 3;
          ctx.shadowBlur = 15;
          ctx.shadowColor = obs.color;
          ctx.strokeRect(obs.x, obs.y, obs.width, obs.height);
          
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.moveTo(obs.x + obs.width/2, obs.y);
          ctx.lineTo(obs.x + obs.width/2, obs.y + obs.height);
          ctx.stroke();

        } else if (obs.themeType === 'structure') {
          // Suburban Brick/Steel Structure
          ctx.fillStyle = '#451a03'; // dark brown
          ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
          
          ctx.strokeStyle = '#78350f';
          ctx.lineWidth = 2;
          ctx.strokeRect(obs.x, obs.y, obs.width, obs.height);
          
          // Crosshatches
          ctx.beginPath();
          for (let i = 0; i < obs.height; i += 40) {
            ctx.moveTo(obs.x, obs.y + i);
            ctx.lineTo(obs.x + obs.width, obs.y + i + 40);
            ctx.moveTo(obs.x + obs.width, obs.y + i);
            ctx.lineTo(obs.x, obs.y + i + 40);
          }
          ctx.stroke();

        } else if (obs.themeType === 'nature') {
          // Rural Trees/Vines
          ctx.fillStyle = '#14532d'; // dark green
          ctx.fillRect(obs.x, obs.y, obs.width, obs.height);
          
          // Leaves/Thorns
          ctx.fillStyle = obs.color; // yellow-ish accents
          for (let i = 10; i < obs.height; i += 30) {
            ctx.beginPath();
            ctx.arc(obs.x + (i % 60 === 10 ? 0 : obs.width), obs.y + i, 10, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });

      // 5. Particles
      particles.forEach((p) => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 1 - p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1.0;

      // 6. Drone
      if (state.gameState !== 'gameover' || particles.length > 0) {
        if (state.gameState !== 'gameover') {
          ctx.save();
          ctx.translate(drone.x, drone.y);
          ctx.rotate(drone.rotation);

          // Drone Body
          ctx.shadowBlur = 15;
          ctx.shadowColor = currentTheme.accent;
          ctx.fillStyle = '#0f172a';
          ctx.strokeStyle = currentTheme.accent;
          ctx.lineWidth = 3;
          
          // Center chassis
          ctx.beginPath();
          ctx.arc(0, 0, 12, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          // Arms
          ctx.beginPath();
          ctx.moveTo(-15, 0);
          ctx.lineTo(-25, -10);
          ctx.moveTo(15, 0);
          ctx.lineTo(25, -10);
          ctx.stroke();

          // Rotors
          ctx.fillStyle = currentTheme.accent;
          ctx.fillRect(-32, -12, 14, 4);
          ctx.fillRect(18, -12, 14, 4);
          
          // Rotor blur effect
          if (state.gameState === 'playing') {
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = '#fff';
            ctx.fillRect(-34, -13, 18, 6);
            ctx.fillRect(16, -13, 18, 6);
            ctx.globalAlpha = 1.0;
          }

          ctx.restore();
        }
      }

      animationFrameId.current = requestAnimationFrame(loop);
    };

    animationFrameId.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(animationFrameId.current);
    };
  }, []);

  const goToTrainingMenu = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.location.assign('../training.html');
  };

  return (
    <div className="fixed inset-0 bg-black select-none touch-none overflow-hidden">
      {isPortrait && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-8 bg-slate-950 z-50">
          <RotateCcw size={48} className="mb-4" />
          <h2 className="text-2xl font-bold mb-2 text-center">Please Rotate Device</h2>
          <p className="text-slate-400 text-center">Drone Dash requires landscape mode.</p>
          <a
            href="../training.html"
            onClick={goToTrainingMenu}
            onPointerDown={(e) => e.stopPropagation()}
            className="mt-8 inline-flex items-center justify-center gap-2 min-h-[44px] min-w-[44px] px-4 py-2 rounded-full bg-white/10 text-slate-200 text-sm font-semibold border border-white/20 hover:bg-white/20 pointer-events-auto touch-manipulation z-[100]"
          >
            <ArrowLeft size={18} className="shrink-0" />
            Training menu
          </a>
        </div>
      )}

      {!isPortrait && (
        <a
          href="../training.html"
          onClick={goToTrainingMenu}
          onPointerDown={(e) => e.stopPropagation()}
          className="fixed z-[100] inline-flex items-center justify-center gap-2 min-h-[44px] px-3 sm:px-4 py-2.5 rounded-full bg-black/55 text-slate-100 text-xs sm:text-sm font-semibold border border-white/15 hover:bg-black/75 pointer-events-auto backdrop-blur-sm max-w-[calc(100vw-1.5rem)] touch-manipulation"
          style={{
            top: 'max(0.75rem, env(safe-area-inset-top))',
            right: 'max(0.75rem, env(safe-area-inset-right))',
          }}
        >
          <ArrowLeft size={18} className="shrink-0" />
          Training menu
        </a>
      )}

      <div className="relative w-full h-full overflow-hidden">
        
        {/* HUD — top-left row: score, high score, zone (stays under training link on the right) */}
        <div
          className="absolute z-10 flex flex-row flex-wrap items-center gap-x-2 sm:gap-x-3 gap-y-1 pointer-events-none max-w-[min(100%,calc(100vw-9rem))]"
          style={{
            top: 'max(0.65rem, env(safe-area-inset-top))',
            left: 'max(0.65rem, env(safe-area-inset-left))',
          }}
        >
          <div className="text-white font-mono font-bold tracking-wide drop-shadow-md shrink-0 text-sm sm:text-base tabular-nums">
            <span className="text-slate-400 font-semibold text-xs sm:text-sm mr-1">SCORE</span>
            {score}
          </div>
          {highScore > 0 && (
            <div className="text-slate-300 font-mono flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded w-fit shrink-0 text-xs sm:text-sm">
              <Trophy size={12} className="text-yellow-400 shrink-0" />
              <span className="text-slate-500 mr-0.5">HI</span>
              {highScore}
            </div>
          )}
          <div
            className="text-slate-200 font-mono flex items-center gap-1 bg-black/40 px-1.5 py-0.5 rounded min-w-0 max-w-[40vw] sm:max-w-none text-xs sm:text-sm"
            title={currentThemeName}
          >
            <Map size={12} className="shrink-0" />
            <span className="truncate">
              <span className="text-slate-500 mr-1">ZONE</span>
              {currentThemeName}
            </span>
          </div>
        </div>

        {/* Game Canvas */}
        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="w-full h-full object-cover bg-slate-900 block touch-none"
          onMouseDown={handleThrustStart}
          onMouseUp={handleThrustEnd}
          onMouseLeave={handleThrustEnd}
          onTouchStart={handleThrustStart}
          onTouchEnd={handleThrustEnd}
          onTouchCancel={handleThrustEnd}
        />

        {/* Start Screen Overlay */}
        {gameState === 'start' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-950/80 backdrop-blur-sm pointer-events-none">
            <h1 className="pointer-events-none text-6xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-blue-500 tracking-tighter mb-4 drop-shadow-[0_0_15px_rgba(34,211,238,0.5)]">
              DRONE DASH
            </h1>
            <p className="pointer-events-none text-slate-300 font-mono mb-8 text-center max-w-md">
              Hold <kbd className="bg-slate-800 px-2 py-1 rounded text-cyan-400">SPACE</kbd> or <kbd className="bg-slate-800 px-2 py-1 rounded text-cyan-400">TAP</kbd> to fly up.<br/>
              Release to fall.<br/>
              Survive to reach new zones!
            </p>
            <button 
              type="button"
              onClick={(e) => { e.stopPropagation(); beginCountdown(); }}
              className="pointer-events-auto group relative px-8 py-4 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xl rounded-full transition-all hover:scale-105 active:scale-95 flex items-center gap-3 touch-manipulation"
            >
              <Play fill="currentColor" />
              START SYSTEM
              <div className="absolute inset-0 rounded-full ring-4 ring-cyan-400/50 animate-ping opacity-20 group-hover:opacity-100"></div>
            </button>
          </div>
        )}

        {gameState === 'countdown' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/65 backdrop-blur-sm pointer-events-none">
            <div
              key={countdownLabel}
              className="text-[min(22vw,7rem)] font-black tabular-nums tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-cyan-300 to-blue-500 drop-shadow-[0_0_36px_rgba(34,211,238,0.5)]"
            >
              {countdownLabel === 'go' ? 'GO!' : countdownLabel}
            </div>
          </div>
        )}

        {/* Game Over Overlay */}
        {gameState === 'gameover' && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-rose-950/90 backdrop-blur-md animate-in fade-in duration-300 pointer-events-none">
            <h2 className="pointer-events-none text-5xl font-black text-rose-500 tracking-tighter mb-2 drop-shadow-[0_0_15px_rgba(244,63,94,0.5)]">
              SYSTEM FAILURE
            </h2>
            <div className="pointer-events-none text-white font-mono text-2xl mb-8 flex flex-col items-center gap-2">
              <span>FINAL SCORE: {score}</span>
              <span className="text-slate-300 text-lg">REACHED: {currentThemeName}</span>
              {score >= highScore && score > 0 && (
                <span className="text-yellow-400 text-sm animate-pulse flex items-center gap-2 mt-2">
                  <Trophy size={16} /> NEW HIGH SCORE!
                </span>
              )}
            </div>
            <button 
              type="button"
              onClick={(e) => { e.stopPropagation(); beginCountdown(); }}
              className="pointer-events-auto px-8 py-4 bg-white hover:bg-slate-200 text-rose-950 font-bold text-xl rounded-full transition-all hover:scale-105 active:scale-95 flex items-center gap-3 shadow-[0_0_20px_rgba(255,255,255,0.3)] touch-manipulation"
            >
              <RotateCcw />
              REBOOT
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


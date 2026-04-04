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
    bg: '#0f172a',
    floor: '#020617',
    accent: '#22d3ee',
    obsColor: '#f43f5e',
    bgType: 'city',
    obsType: 'laser'
  },
  {
    name: 'Suburban Dusk',
    bg: '#2e1065',
    floor: '#172554',
    accent: '#f59e0b',
    obsColor: '#10b981',
    bgType: 'suburb',
    obsType: 'structure'
  },
  {
    name: 'Rural Night',
    bg: '#064e3b',
    floor: '#022c22',
    accent: '#a3e635',
    obsColor: '#eab308',
    bgType: 'rural',
    obsType: 'nature'
  },
  {
    name: 'Arctic Run',
    bg: '#0c4a6e',
    floor: '#082f49',
    accent: '#7dd3fc',
    obsColor: '#e0f2fe',
    bgType: 'arctic',
    obsType: 'ice'
  },
  {
    name: 'Desert Dusk',
    bg: '#431407',
    floor: '#292524',
    accent: '#fb923c',
    obsColor: '#fcd34d',
    bgType: 'desert',
    obsType: 'mesa'
  },
  {
    name: 'Harbor Night',
    bg: '#0f172a',
    floor: '#020617',
    accent: '#38bdf8',
    obsColor: '#f97316',
    bgType: 'harbor',
    obsType: 'container'
  }
];

/** Score band per zone before cycling themes (longer runs see all zones). */
const POINTS_PER_ZONE = 130;

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
  /** Horizontal oscillation amplitude (px); collision uses x + offsetX. */
  wobbleAmp: number;
  wobblePhase: number;
  offsetX: number;
  /** Extra world scroll speed (positive = moves left faster). */
  driftX: number;
  scoreValue: number;
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
    } else if (theme.bgType === 'arctic') {
      width = 70 + Math.random() * 100;
      height = 120 + Math.random() * 220;
      speed = 0.8 + Math.random() * 1.2;
      color = Math.random() > 0.5 ? '#075985' : '#0e7490';
    } else if (theme.bgType === 'desert') {
      width = 90 + Math.random() * 140;
      height = 50 + Math.random() * 90;
      speed = 1 + Math.random() * 1.2;
      color = Math.random() > 0.5 ? '#7c2d12' : '#9a3412';
    } else if (theme.bgType === 'harbor') {
      width = 50 + Math.random() * 70;
      height = 90 + Math.random() * 200;
      speed = 1.2 + Math.random() * 1.5;
      color = Math.random() > 0.5 ? '#1e3a5f' : '#334155';
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

  const difficultyTier = () => Math.min(12, Math.floor(stateRef.current.score / 90));

  const pushObstacle = (o: Omit<Obstacle, 'passed' | 'offsetX'>) => {
    obstaclesRef.current.push({ ...o, passed: false, offsetX: 0 });
  };

  /** Flappy-style gap; returns true if spawned. */
  const spawnGatePair = (): boolean => {
    const theme = THEMES[stateRef.current.themeIndex];
    const tier = difficultyTier();
    const playable = FLOOR_Y - CEILING_Y;
    const minBlock = 48;
    const gap = Math.max(108, 210 - Math.min(stateRef.current.score, 140) * 0.45 - tier * 3);
    const maxCenter = FLOOR_Y - gap / 2 - minBlock;
    const minCenter = CEILING_Y + gap / 2 + minBlock;
    if (maxCenter <= minCenter) return false;
    const gapCenter = minCenter + Math.random() * (maxCenter - minCenter);
    const topH = gapCenter - gap / 2 - CEILING_Y;
    const botY = gapCenter + gap / 2;
    const botH = FLOOR_Y - botY;
    if (topH < minBlock || botH < minBlock) return false;

    const w = 48 + Math.random() * 72;
    const phase = Math.random() * Math.PI * 2;
    const wobbleAmp = tier >= 5 && Math.random() > 0.55 ? 8 + Math.random() * 18 : tier >= 3 && Math.random() > 0.75 ? 5 + Math.random() * 10 : 0;
    const driftX = tier >= 4 && Math.random() > 0.6 ? (Math.random() > 0.5 ? 1.4 : -2) : tier >= 2 && Math.random() > 0.82 ? (Math.random() > 0.5 ? 0.8 : -1.2) : 0;

    const base = {
      x: dimRef.current.width,
      width: w,
      vy: 0,
      minY: CEILING_Y,
      maxY: FLOOR_Y,
      themeType: theme.obsType,
      color: theme.obsColor,
      wobbleAmp,
      wobblePhase: phase,
      driftX,
      scoreValue: 8,
    };

    pushObstacle({ ...base, y: CEILING_Y, height: topH, type: 'top' });
    pushObstacle({ ...base, y: botY, height: botH, type: 'bottom' });
    return true;
  };

  const spawnObstacle = () => {
    const theme = THEMES[stateRef.current.themeIndex];
    const tier = difficultyTier();
    const gap = 220 - Math.min(stateRef.current.score, 120) * 0.42 - Math.min(tier * 2, 28);
    const minHeight = 50;
    const maxHeight = Math.max(minHeight, 720 - CEILING_Y - (720 - FLOOR_Y) - gap - minHeight);

    const gateChance = tier >= 2 ? 0.22 + Math.min(tier, 8) * 0.02 : 0;
    if (Math.random() < gateChance && spawnGatePair()) return;

    const typeRoll = Math.random();
    let type: 'top' | 'bottom' | 'floating' = 'bottom';
    let y = 0;
    let height = 0;
    let vy = 0;
    let minY = CEILING_Y;
    let maxY = FLOOR_Y;

    const floatBias = tier >= 4 ? 0.12 : tier >= 2 ? 0.06 : 0;
    const bottomW = 0.32 - floatBias * 0.5;
    const topW = 0.32 - floatBias * 0.5;

    if (typeRoll < bottomW) {
      type = 'bottom';
      height = Math.random() * maxHeight + minHeight;
      y = FLOOR_Y - height;
    } else if (typeRoll < bottomW + topW) {
      type = 'top';
      height = Math.random() * maxHeight + minHeight;
      y = CEILING_Y;
    } else {
      type = 'floating';
      height = 70 + Math.random() * 100;
      y = Math.random() * (FLOOR_Y - CEILING_Y - height) + CEILING_Y;

      if (Math.random() > 0.55 - Math.min(tier, 6) * 0.04) {
        vy = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * (2 + tier * 0.15));
        minY = CEILING_Y + 10;
        maxY = FLOOR_Y - 10;
      }
    }

    const width = type === 'floating' ? 56 + Math.random() * 52 : 52 + Math.random() * 58;
    const wobbleAmp =
      tier >= 3 && Math.random() > 0.72 ? 6 + Math.random() * 16 : tier >= 6 && Math.random() > 0.5 ? 10 + Math.random() * 20 : 0;
    const driftX =
      tier >= 3 && Math.random() > 0.78 ? (Math.random() > 0.5 ? 1.1 : -1.6) : tier >= 7 && Math.random() > 0.55 ? (Math.random() > 0.5 ? 1.6 : -2.2) : 0;

    pushObstacle({
      x: dimRef.current.width,
      y,
      width,
      height,
      type,
      vy,
      minY,
      maxY,
      themeType: theme.obsType,
      color: theme.obsColor,
      wobbleAmp,
      wobblePhase: Math.random() * Math.PI * 2,
      driftX,
      scoreValue: 10,
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

      const spawnRate = Math.max(34, 72 - Math.floor(state.score / 45) - Math.min(difficultyTier(), 6));
      if (state.frames % spawnRate === 0) {
        spawnObstacle();
      }

      for (let i = obstacles.length - 1; i >= 0; i--) {
        const obs = obstacles[i];
        obs.x -= OBSTACLE_SPEED + obs.driftX;
        obs.offsetX = Math.sin((state.frames + obs.wobblePhase) * 0.052) * obs.wobbleAmp;
        const ox = obs.x + obs.offsetX;

        if (obs.vy !== 0) {
          obs.y += obs.vy;
          if (obs.y <= obs.minY || obs.y + obs.height >= obs.maxY) {
            obs.vy *= -1;
          }
        }

        const margin = 8;
        if (
          drone.x + DRONE_SIZE / 2 - margin > ox &&
          drone.x - DRONE_SIZE / 2 + margin < ox + obs.width &&
          drone.y + DRONE_SIZE / 2 - margin > obs.y &&
          drone.y - DRONE_SIZE / 2 + margin < obs.y + obs.height
        ) {
          gameOver();
        }

        if (!obs.passed && drone.x > ox + obs.width) {
          obs.passed = true;
          state.score += obs.scoreValue;
          setScore(state.score);
        }

        if (ox + obs.width + obs.wobbleAmp < 0) {
          obstacles.splice(i, 1);
        }
      }

      updateParticles();
    };

    const loop = (now: number) => {
      const state = stateRef.current;

      // Theme progression: advance through all zones, then cycle
      const newThemeIndex = Math.floor(state.score / POINTS_PER_ZONE) % THEMES.length;
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
        } else if (bg.themeType === 'arctic') {
          ctx.fillRect(bg.x, FLOOR_Y - bg.height, bg.width, bg.height);
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(bg.x, FLOOR_Y - bg.height, bg.width, 8);
          ctx.fillStyle = bg.color;
          ctx.beginPath();
          for (let k = 0; k < 5; k++) {
            const px = bg.x + (k / 5) * bg.width + (bg.seed * 17) % 12;
            ctx.moveTo(px, FLOOR_Y - bg.height);
            ctx.lineTo(px + 8 + (k % 2) * 6, FLOOR_Y - bg.height - 14 - (k * 3) % 10);
            ctx.lineTo(px + 16, FLOOR_Y - bg.height);
          }
          ctx.fill();
        } else if (bg.themeType === 'desert') {
          const y0 = FLOOR_Y - bg.height;
          const g = ctx.createLinearGradient(bg.x, y0, bg.x + bg.width, FLOOR_Y);
          g.addColorStop(0, bg.color);
          g.addColorStop(1, '#292524');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(bg.x - 15, FLOOR_Y);
          ctx.lineTo(bg.x + bg.width * 0.2, y0 + bg.height * 0.35);
          ctx.lineTo(bg.x + bg.width * 0.45, y0);
          ctx.lineTo(bg.x + bg.width * 0.75, y0 + bg.height * 0.25);
          ctx.lineTo(bg.x + bg.width + 20, FLOOR_Y);
          ctx.closePath();
          ctx.fill();
        } else if (bg.themeType === 'harbor') {
          ctx.fillRect(bg.x, FLOOR_Y - bg.height, bg.width, bg.height);
          ctx.fillStyle = 'rgba(56,189,248,0.15)';
          ctx.fillRect(bg.x + 4, FLOOR_Y - bg.height + 6, bg.width - 8, 10);
          ctx.strokeStyle = 'rgba(148,163,184,0.35)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(bg.x + bg.width * 0.85, FLOOR_Y - bg.height);
          ctx.lineTo(bg.x + bg.width * 0.85, FLOOR_Y - bg.height - 40 - bg.seed * 30);
          ctx.lineTo(bg.x + bg.width * 0.55, FLOOR_Y - bg.height - 25 - bg.seed * 20);
          ctx.stroke();
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
      const animT = state.frames;
      obstacles.forEach((obs) => {
        const dx = obs.x + obs.offsetX;
        const midX = dx + obs.width / 2;

        if (obs.themeType === 'laser') {
          const g = ctx.createLinearGradient(dx, obs.y, dx + obs.width, obs.y + obs.height);
          g.addColorStop(0, '#0f172a');
          g.addColorStop(0.5, '#1e293b');
          g.addColorStop(1, '#020617');
          ctx.fillStyle = g;
          ctx.fillRect(dx, obs.y, obs.width, obs.height);

          ctx.strokeStyle = obs.color;
          ctx.lineWidth = 3;
          ctx.shadowBlur = 18;
          ctx.shadowColor = obs.color;
          ctx.strokeRect(dx, obs.y, obs.width, obs.height);
          ctx.shadowBlur = 0;

          const scan = (animT * 3) % 24;
          ctx.setLineDash([6, 10]);
          ctx.lineDashOffset = -scan;
          ctx.beginPath();
          ctx.moveTo(midX, obs.y);
          ctx.lineTo(midX, obs.y + obs.height);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;

          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(midX, obs.y + ((animT * 4) % obs.height), 4, 0, Math.PI * 2);
          ctx.stroke();

        } else if (obs.themeType === 'structure') {
          const g = ctx.createLinearGradient(dx, obs.y, dx, obs.y + obs.height);
          g.addColorStop(0, '#57534e');
          g.addColorStop(0.45, '#451a03');
          g.addColorStop(1, '#292524');
          ctx.fillStyle = g;
          ctx.fillRect(dx, obs.y, obs.width, obs.height);

          ctx.strokeStyle = '#78350f';
          ctx.lineWidth = 2;
          ctx.strokeRect(dx, obs.y, obs.width, obs.height);

          const brickH = 14;
          for (let row = 0; row < obs.height; row += brickH) {
            const offset = row % (brickH * 2) === 0 ? 0 : obs.width * 0.18;
            for (let col = -obs.width; col < obs.width * 2; col += obs.width * 0.36) {
              ctx.strokeStyle = 'rgba(0,0,0,0.35)';
              ctx.strokeRect(dx + offset + col, obs.y + row, obs.width * 0.34, brickH - 1);
            }
          }

          ctx.strokeStyle = obs.color;
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          for (let i = 0; i < obs.height; i += 36) {
            ctx.moveTo(dx, obs.y + i);
            ctx.lineTo(dx + obs.width, obs.y + i + 36);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;

        } else if (obs.themeType === 'nature') {
          const g = ctx.createLinearGradient(dx, obs.y, dx + obs.width, obs.y);
          g.addColorStop(0, '#166534');
          g.addColorStop(1, '#14532d');
          ctx.fillStyle = g;
          ctx.fillRect(dx, obs.y, obs.width, obs.height);

          ctx.fillStyle = '#052e16';
          ctx.fillRect(dx + obs.width * 0.35, obs.y, obs.width * 0.3, obs.height);

          for (let i = 12; i < obs.height; i += 26) {
            const side = (i + animT) % 52 < 26 ? 0 : obs.width;
            const leafG = ctx.createRadialGradient(dx + side, obs.y + i, 2, dx + side, obs.y + i, 16);
            leafG.addColorStop(0, obs.color);
            leafG.addColorStop(1, 'rgba(20,83,45,0.2)');
            ctx.fillStyle = leafG;
            ctx.beginPath();
            ctx.arc(dx + side, obs.y + i, 12 + (i % 7) * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }

        } else if (obs.themeType === 'ice') {
          const g = ctx.createLinearGradient(dx, obs.y, dx + obs.width, obs.y + obs.height);
          g.addColorStop(0, '#e0f2fe');
          g.addColorStop(0.4, '#7dd3fc');
          g.addColorStop(1, '#0369a1');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(dx, obs.y + obs.height);
          for (let s = 0; s <= 8; s++) {
            const px = dx + (s / 8) * obs.width;
            const spike = Math.sin(s * 1.7 + obs.wobblePhase) * 6;
            ctx.lineTo(px, obs.y + 10 + spike);
          }
          ctx.lineTo(dx + obs.width, obs.y + obs.height);
          ctx.closePath();
          ctx.fill();

          ctx.strokeStyle = 'rgba(255,255,255,0.65)';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          for (let k = 0; k < 4; k++) {
            const fx = dx + ((k * 37 + animT) % obs.width);
            const fy = obs.y + ((k * 61 + animT * 2) % obs.height);
            ctx.fillRect(fx, fy, 2, 2);
          }

        } else if (obs.themeType === 'mesa') {
          const layers = 4;
          for (let L = 0; L < layers; L++) {
            const t = L / layers;
            const inset = t * obs.width * 0.12;
            const y1 = obs.y + t * obs.height * 0.85;
            const y2 = obs.y + ((t + 0.22) * obs.height * 0.92);
            const g2 = ctx.createLinearGradient(dx + inset, y1, dx + obs.width - inset, y2);
            const warm = L % 2 === 0 ? '#9a3412' : '#c2410c';
            g2.addColorStop(0, warm);
            g2.addColorStop(1, '#431407');
            ctx.fillStyle = g2;
            ctx.fillRect(dx + inset, y1, obs.width - inset * 2, Math.max(8, y2 - y1));
          }
          ctx.strokeStyle = obs.color;
          ctx.globalAlpha = 0.5;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(dx, obs.y + obs.height);
          ctx.lineTo(dx + obs.width * 0.15, obs.y + obs.height * 0.35);
          ctx.lineTo(dx + obs.width * 0.5, obs.y);
          ctx.lineTo(dx + obs.width * 0.85, obs.y + obs.height * 0.38);
          ctx.lineTo(dx + obs.width, obs.y + obs.height);
          ctx.stroke();
          ctx.globalAlpha = 1;

        } else if (obs.themeType === 'container') {
          const g = ctx.createLinearGradient(dx, obs.y, dx + obs.width, obs.y);
          g.addColorStop(0, '#334155');
          g.addColorStop(0.5, '#1e293b');
          g.addColorStop(1, '#0f172a');
          ctx.fillStyle = g;
          ctx.fillRect(dx, obs.y, obs.width, obs.height);

          ctx.strokeStyle = 'rgba(148,163,184,0.5)';
          ctx.lineWidth = 1;
          for (let vx = 6; vx < obs.width; vx += 11) {
            ctx.beginPath();
            ctx.moveTo(dx + vx, obs.y);
            ctx.lineTo(dx + vx, obs.y + obs.height);
            ctx.stroke();
          }

          ctx.save();
          ctx.strokeStyle = obs.color;
          ctx.lineWidth = 5;
          ctx.globalAlpha = 0.85;
          const stripeOff = (animT * 2) % 28;
          ctx.setLineDash([14, 14]);
          ctx.lineDashOffset = stripeOff;
          ctx.beginPath();
          ctx.moveTo(dx - 20, obs.y + obs.height + 20);
          ctx.lineTo(dx + obs.width + 20, obs.y - 20);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          ctx.fillStyle = obs.color;
          ctx.globalAlpha = 0.9;
          ctx.fillRect(dx + 4, obs.y + 6, obs.width * 0.35, 5);
          ctx.globalAlpha = 1;
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


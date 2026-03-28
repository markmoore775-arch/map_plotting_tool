import { useEffect, useRef, useState } from 'react';
import { Play, RotateCcw, Trophy, Zap, Heart } from 'lucide-react';

// --- Game Constants ---
const DRONE_SIZE = 30;
const BASE_SPEED = 1.8;
/** Peak scroll multiplier (start is 1×). Capped — difficulty does not rise forever. */
const MAX_SPEED_MULTIPLIER = 1.58 * 1.2;
/**
 * Wall-clock seconds until speed nears MAX_SPEED_MULTIPLIER (was 18_000 frames @ 60fps).
 * Uses real time so 120Hz / throttled RAF cannot rush difficulty.
 */
const SPEED_RAMP_SECONDS = 18_000 / 60;
/** Spawn chance ramps to cap over this many seconds (was 24_000 frames @ 60fps). */
const SPAWN_RAMP_SECONDS = 24_000 / 60;
/** +20% vs former 0.08 / 0.28 → more enemies at each spawn roll. */
const SPAWN_CHANCE_BASE = 0.08 * 1.2;
const SPAWN_CHANCE_CAP = 0.28 * 1.2;
/** Normalize physics to this reference framerate (scroll, timers, shots). */
const REFERENCE_FPS = 60;
const MAX_DELTA_SEC = 0.05;
/** Same cadence as former 12 frames @ 60fps. */
const SHOT_INTERVAL_MS = (12 / REFERENCE_FPS) * 1000;
/** No real movement for this long → drift + spawns biased toward player. */
const IDLE_POSITION_SEC = 1.45;

function easeOutPow(t: number, power: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, power);
}

// --- Map Constants (Central London, Zoom 16) ---
const MAP_ZOOM = 16;
// Pre-calculated pixel coordinates for 51.5074° N, 0.1278° W at Zoom 16
const START_PIXEL_X_BASE = 8382650; 
const START_PIXEL_Y = 5577835;

// --- Tile Cache ---
const tileCache = new Map<string, HTMLImageElement>();
const getTile = (z: number, x: number, y: number) => {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  
  const img = new Image();
  img.crossOrigin = "anonymous";
  // Using CartoDB Positron for a lighter map
  img.src = `https://a.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`;
  
  // Pre-decode the image for smoother rendering once loaded
  img.decode().catch(() => {
    // Ignore decode errors, it will just render normally when drawn
  });

  tileCache.set(key, img);
  return img;
};

interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  color: string;
  rotation: number;
  health: number;
}

interface Obstacle {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'plane' | 'drone' | 'helicopter';
  color: string;
  startX: number;
  range: number;
  phase: number;
}

interface Collectible {
  id: number;
  x: number;
  y: number;
  radius: number;
  color: string;
  type: 'data' | 'firstaid';
}

interface Projectile {
  x: number;
  y: number;
  vy: number;
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

export default function DroneGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gameState, setGameState] = useState<'start' | 'playing' | 'gameover'>('start');
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [multiplier, setMultiplier] = useState(1);
  const [multiplierTimeLeft, setMultiplierTimeLeft] = useState(0);
  const [health, setHealth] = useState(3);
  const [dimensions, setDimensions] = useState({ width: 400, height: 600 });

  useEffect(() => {
    const updateDimensions = () => {
      // Fill the entire screen
      const maxWidth = window.innerWidth;
      const maxHeight = window.innerHeight;
      setDimensions({ width: maxWidth, height: maxHeight });
      
      if (gameRef.current) {
        gameRef.current.width = maxWidth;
        gameRef.current.height = maxHeight;
      }
    };
    
    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, []);

  // Mutable game state for the animation loop
  const gameRef = useRef({
    width: 400,
    height: 600,
    player: {
      x: 400 / 2 - DRONE_SIZE / 2,
      y: 600 - 120,
      width: DRONE_SIZE,
      height: DRONE_SIZE,
      vx: 0,
      vy: 0,
      color: '#ef4444',
      rotation: 0,
      health: 3
    } as Player,
    obstacles: [] as Obstacle[],
    collectibles: [] as Collectible[],
    projectiles: [] as Projectile[],
    trail: [] as {x: number, y: number}[],
    scrollDistance: 0,
    distanceSinceLastSpawn: 0,
    particles: [] as Particle[],
    keys: {} as Record<string, boolean>,
    /** Accumulated “60fps frames” for visuals (rotors, sin waves). */
    tRef: 0,
    /** Wall-clock session time for difficulty ramps only. */
    difficultySeconds: 0,
    lastFrameTimeMs: 0,
    lastShotMs: 0,
    scorePulseAccum: 0,
    multUiAccum: 0,
    crashFxAccum: 0,
    idleSec: 0,
    lastIdlePx: 0,
    lastIdlePy: 0,
    score: 0,
    multiplier: 1,
    multiplierTimer: 0,
    speedMultiplier: 1,
    animationId: 0,
    isCrashing: false,
    crashTimer: 0,
    invulnerableTimer: 0,
    nextId: 0,
  });

  // Handle Keyboard Input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      gameRef.current.keys[e.code] = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      gameRef.current.keys[e.code] = false;
    };

    window.addEventListener('keydown', handleKeyDown, { passive: false });
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // Handle Touch Input
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let touchStartX = 0;
    let touchStartY = 0;

    const handleTouchStart = (e: TouchEvent) => {
      e.preventDefault();
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    };

    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (gameRef.current.isCrashing) return;

      const touchX = e.touches[0].clientX;
      const touchY = e.touches[0].clientY;
      
      const dx = touchX - touchStartX;
      const dy = touchY - touchStartY;
      
      gameRef.current.player.vx += dx * 0.15;
      gameRef.current.player.vy += dy * 0.15;
      
      touchStartX = touchX;
      touchStartY = touchY;
    };

    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
    };
  }, [gameState]);

  // Game Loop
  useEffect(() => {
    if (gameState !== 'playing') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const state = gameRef.current;

    const spawnParticles = (x: number, y: number, color: string, count: number, maxSpeed: number = 10) => {
      for (let i = 0; i < count; i++) {
        state.particles.push({
          x,
          y,
          vx: (Math.random() - 0.5) * maxSpeed,
          vy: (Math.random() - 0.5) * maxSpeed,
          life: 1,
          maxLife: Math.random() * 30 + 20,
          color,
          size: Math.random() * 4 + 2
        });
      }
    };

    const initiateCrash = (bounceVx: number, bounceVy: number) => {
      state.player.health -= 1;
      setHealth(state.player.health);
      
      const px = state.player.x + state.player.width / 2;
      const py = state.player.y + state.player.height / 2;
      
      spawnParticles(px, py, '#ef4444', 50, 15);
      spawnParticles(px, py, '#f97316', 40, 10);
      spawnParticles(px, py, '#eab308', 30, 8);
      spawnParticles(px, py, state.player.color, 20, 12);
      spawnParticles(px, py, '#ffffff', 15, 20);

      if (state.player.health <= 0) {
        state.isCrashing = true;
        state.crashTimer = 60;
        state.player.vx = bounceVx;
        state.player.vy = bounceVy;
        state.player.rotation = 0;
      } else {
        state.invulnerableTimer = 120; // 2 seconds of invulnerability
        state.player.vx = bounceVx * 0.5;
        state.player.vy = bounceVy * 0.5;
      }
    };

    const drawDrone = (ctx: CanvasRenderingContext2D, p: Player) => {
      if (state.invulnerableTimer > 0 && Math.floor(state.tRef / 5) % 2 === 0) {
        return; // Blink
      }
      ctx.save();
      ctx.translate(p.x + p.width / 2, p.y + p.height / 2);
      
      const tilt = state.isCrashing ? p.rotation : p.vx * 0.05;
      ctx.rotate(tilt);

      const isPowered = !state.isCrashing;
      const themeColor = state.multiplier > 1 ? '#3b82f6' : p.color;
      const strokeColor = state.isCrashing ? '#334155' : themeColor;

      // Arms
      ctx.strokeStyle = '#0f172a'; // Very dark slate
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-p.width/2 + 2, -p.height/2 + 2);
      ctx.lineTo(p.width/2 - 2, p.height/2 - 2);
      ctx.moveTo(p.width/2 - 2, -p.height/2 + 2);
      ctx.lineTo(-p.width/2 + 2, p.height/2 - 2);
      ctx.stroke();

      // Central Body (Octagon-ish)
      ctx.fillStyle = '#020617'; // Almost black
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-8, -12);
      ctx.lineTo(8, -12);
      ctx.lineTo(12, -8);
      ctx.lineTo(12, 8);
      ctx.lineTo(8, 12);
      ctx.lineTo(-8, 12);
      ctx.lineTo(-12, 8);
      ctx.lineTo(-12, -8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (isPowered) {
        const rotorSize = 14;
        const rotorOffset = p.width / 2;
        
        const drawRotor = (rx: number, ry: number) => {
          ctx.save();
          ctx.translate(rx, ry);
          
          // Rotor Guard
          ctx.beginPath();
          ctx.arc(0, 0, rotorSize/2 + 1, 0, Math.PI * 2);
          ctx.strokeStyle = '#020617';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 1;
          ctx.stroke();

          // Spinning blades
          ctx.rotate(state.tRef * 0.4);
          ctx.globalAlpha = 0.6;
          ctx.fillStyle = '#64748b'; // Darker blades
          ctx.beginPath();
          ctx.ellipse(0, 0, rotorSize, rotorSize/4, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.ellipse(0, 0, rotorSize/4, rotorSize, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };

        drawRotor(-rotorOffset, -rotorOffset);
        drawRotor(rotorOffset, -rotorOffset);
        drawRotor(-rotorOffset, rotorOffset);
        drawRotor(rotorOffset, rotorOffset);

        // Core glow
        ctx.shadowBlur = 15;
        ctx.shadowColor = themeColor;
        ctx.fillStyle = themeColor;
        ctx.beginPath();
        ctx.arc(0, 0, state.multiplier > 1 ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Dead core
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.arc(0, 0, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Crash X
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-10, -10);
        ctx.lineTo(10, 10);
        ctx.moveTo(10, -10);
        ctx.lineTo(-10, 10);
        ctx.stroke();
      }

      ctx.restore();
    };

    const drawEnemyDrone = (ctx: CanvasRenderingContext2D, obs: Obstacle) => {
      ctx.save();
      ctx.translate(obs.x + obs.width / 2, obs.y + obs.height / 2);
      
      const tilt = Math.cos(state.tRef * 0.05 + obs.phase) * 0.2;
      ctx.rotate(tilt);

      const baseColor = '#064e3b'; // Dark emerald
      const accentColor = obs.color; // The green color passed in

      // Arms (X shape)
      ctx.strokeStyle = '#022c22'; // Very dark green
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-obs.width/2 + 2, -obs.height/2 + 2);
      ctx.lineTo(obs.width/2 - 2, obs.height/2 - 2);
      ctx.moveTo(obs.width/2 - 2, -obs.height/2 + 2);
      ctx.lineTo(-obs.width/2 + 2, obs.height/2 - 2);
      ctx.stroke();

      // Body (Diamond/Angular)
      ctx.fillStyle = baseColor;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(12, 0);
      ctx.lineTo(0, 12);
      ctx.lineTo(-12, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Rotors
      const rotorSize = 12;
      const rotorOffset = obs.width / 2 - 2;
      
      const drawRotor = (rx: number, ry: number) => {
        ctx.save();
        ctx.translate(rx, ry);
        
        // Rotor Hub
        ctx.fillStyle = '#022c22';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();

        // Spinning blades
        ctx.rotate(-state.tRef * 0.6);
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.ellipse(0, 0, rotorSize, rotorSize/4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.ellipse(0, 0, rotorSize/4, rotorSize, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };

      drawRotor(-rotorOffset, -rotorOffset);
      drawRotor(rotorOffset, -rotorOffset);
      drawRotor(-rotorOffset, rotorOffset);
      drawRotor(rotorOffset, rotorOffset);

      // Core eye
      ctx.shadowBlur = 10;
      ctx.shadowColor = accentColor;
      ctx.fillStyle = '#a7f3d0'; // Light green
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    const drawPlane = (ctx: CanvasRenderingContext2D, obs: Obstacle) => {
      ctx.save();
      ctx.translate(obs.x + obs.width / 2, obs.y + obs.height / 2);
      
      ctx.fillStyle = '#64748b';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 2;
      
      ctx.beginPath();
      ctx.moveTo(0, obs.height / 2); // Nose
      ctx.lineTo(obs.width * 0.15, obs.height * 0.25); // Right nose
      ctx.lineTo(obs.width / 2, -obs.height * 0.05); // Right wing tip
      ctx.lineTo(obs.width / 2, -obs.height * 0.2); // Right wing tip back
      ctx.lineTo(obs.width * 0.15, -obs.height * 0.2); // Right wing root back
      ctx.lineTo(obs.width * 0.1, -obs.height * 0.35); // Right fuselage back
      ctx.lineTo(obs.width * 0.3, -obs.height * 0.45); // Right tail tip
      ctx.lineTo(obs.width * 0.3, -obs.height / 2); // Right tail back
      ctx.lineTo(-obs.width * 0.3, -obs.height / 2); // Left tail back
      ctx.lineTo(-obs.width * 0.3, -obs.height * 0.45); // Left tail tip
      ctx.lineTo(-obs.width * 0.1, -obs.height * 0.35); // Left fuselage back
      ctx.lineTo(-obs.width * 0.15, -obs.height * 0.2); // Left wing root back
      ctx.lineTo(-obs.width / 2, -obs.height * 0.2); // Left wing tip back
      ctx.lineTo(-obs.width / 2, -obs.height * 0.05); // Left wing tip
      ctx.lineTo(-obs.width * 0.15, obs.height * 0.25); // Left nose
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      
      // Engine glow
      ctx.shadowBlur = 8;
      ctx.shadowColor = '#38bdf8';
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(-obs.width * 0.15, -obs.height / 2, 2, 0, Math.PI * 2);
      ctx.arc(obs.width * 0.15, -obs.height / 2, 2, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.restore();
    };

    const drawHelicopter = (ctx: CanvasRenderingContext2D, obs: Obstacle) => {
      ctx.save();
      ctx.translate(obs.x + obs.width / 2, obs.y + obs.height / 2);

      const tilt = Math.sin(state.tRef * 0.05 + obs.phase) * 0.1;
      ctx.rotate(tilt);

      // Tail
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(0, -obs.height * 0.2);
      ctx.lineTo(0, obs.height * 0.2);
      ctx.lineTo(0, obs.height * 0.45);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#1e293b';
      ctx.stroke();

      // Tail rotor
      ctx.save();
      ctx.translate(0, obs.height * 0.45);
      ctx.rotate(state.tRef * 0.8);
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.ellipse(0, 0, 8, 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Body (Cockpit)
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(0, 0, obs.width * 0.3, obs.height * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      // Windshield
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.ellipse(0, -obs.height * 0.15, obs.width * 0.2, obs.height * 0.15, 0, 0, Math.PI * 2);
      ctx.fill();

      // Police Lights (Flashing Red/Blue)
      const isRed = Math.floor(state.tRef / 10) % 2 === 0;
      ctx.fillStyle = isRed ? '#ef4444' : '#3b82f6';
      ctx.shadowBlur = 10;
      ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath();
      ctx.arc(-obs.width * 0.15, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = !isRed ? '#ef4444' : '#3b82f6';
      ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath();
      ctx.arc(obs.width * 0.15, 0, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Main Rotor
      ctx.save();
      ctx.rotate(-state.tRef * 0.4);
      ctx.fillStyle = '#cbd5e1';
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(0, 0, obs.width * 0.8, 4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, 4, obs.width * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Rotor Hub
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    };

    const update = () => {
      const p = state.player;
      const now = performance.now();
      let dt = 0;
      if (state.lastFrameTimeMs <= 0) {
        state.lastFrameTimeMs = now;
        dt = 1 / REFERENCE_FPS;
      } else {
        dt = Math.min((now - state.lastFrameTimeMs) / 1000, MAX_DELTA_SEC);
        state.lastFrameTimeMs = now;
      }
      const rf = dt * REFERENCE_FPS;
      state.difficultySeconds += dt;
      state.tRef += rf;

      // Scroll speed: wall-clock ramp (immune to 120Hz / throttled RAF).
      const speedT = state.difficultySeconds / SPEED_RAMP_SECONDS;
      const speedEase = easeOutPow(speedT, 2.35);
      state.speedMultiplier = 1 + (MAX_SPEED_MULTIPLIER - 1) * speedEase;
      const speed = BASE_SPEED * state.speedMultiplier;

      // Update Multiplier Timer
      if (state.multiplierTimer > 0) {
        state.multiplierTimer -= rf;
        if (state.multiplierTimer <= 0) {
          state.multiplier = 1;
          setMultiplier(1);
        }
        state.multUiAccum += rf;
        if (state.multUiAccum >= 5) {
          state.multUiAccum -= 5;
          setMultiplierTimeLeft(Math.max(0, Math.ceil(state.multiplierTimer)));
        }
      }

      if (state.invulnerableTimer > 0) {
        state.invulnerableTimer -= rf;
      }

      if (state.isCrashing) {
        p.vy += 0.5 * rf;
        p.x += p.vx * rf;
        p.y += p.vy * rf;
        p.rotation += p.vx * 0.1 * rf;

        state.crashFxAccum += rf;
        if (state.crashFxAccum >= 2) {
          state.crashFxAccum -= 2;
          spawnParticles(p.x + p.width/2, p.y + p.height/2, '#f97316', 2, 4);
          spawnParticles(p.x + p.width/2, p.y + p.height/2, '#475569', 3, 2);
        }

        state.crashTimer -= rf;
        if (state.crashTimer <= 0) {
          setGameState('gameover');
          return;
        }
      } else {
        // Normal Player Movement (scaled to reference 60fps)
        if (state.keys['ArrowLeft'] || state.keys['KeyA']) p.vx -= 1.0 * rf;
        if (state.keys['ArrowRight'] || state.keys['KeyD']) p.vx += 1.0 * rf;
        if (state.keys['ArrowUp'] || state.keys['KeyW']) p.vy -= 1.0 * rf;
        if (state.keys['ArrowDown'] || state.keys['KeyS']) p.vy += 1.0 * rf;

        const friction = Math.pow(0.82, rf);
        p.vx *= friction;
        p.vy *= friction;

        p.x += p.vx * rf;
        p.y += p.vy * rf;

        // Bounds (Screen)
        if (p.x < 0) { p.x = 0; p.vx = 0; }
        if (p.x + p.width > state.width) { p.x = state.width - p.width; p.vx = 0; }
        if (p.y < 0) { p.y = 0; p.vy = 0; }
        if (p.y + p.height > state.height) { p.y = state.height - p.height; p.vy = 0; }

        // Idle = no real movement (can't AFK in a safe lane)
        const moved =
          Math.abs(p.x - state.lastIdlePx) > 0.85 || Math.abs(p.y - state.lastIdlePy) > 0.85;
        if (moved) {
          state.idleSec = 0;
          state.lastIdlePx = p.x;
          state.lastIdlePy = p.y;
        } else {
          state.idleSec += dt;
        }
        const afkPosition = state.idleSec >= IDLE_POSITION_SEC;
        if (afkPosition) {
          p.vx += Math.sin(state.difficultySeconds * 2.05) * 0.6 * rf;
          p.vy += Math.cos(state.difficultySeconds * 1.65) * 0.28 * rf;
        }

        // Shooting: Space on desktop; continuous autofire on coarse-pointer (touch) devices
        const touchAutofire =
          typeof window !== 'undefined' &&
          window.matchMedia('(pointer: coarse)').matches;
        const wantFire = state.keys['Space'] || touchAutofire;
        if (wantFire && now - state.lastShotMs >= SHOT_INTERVAL_MS) {
          state.projectiles.push({
            x: p.x + p.width / 2 - 2,
            y: p.y,
            vy: -12,
            color: state.multiplier > 1 ? '#1d4ed8' : '#c2410c'
          });
          state.lastShotMs = now;
        }

        // Update Trail
        state.trail.unshift({ x: p.x + p.width / 2, y: p.y + p.height / 2 });
        if (state.trail.length > 15) state.trail.pop();

        // Score — same rate as former “every 5 ref frames”
        state.scorePulseAccum += rf;
        while (state.scorePulseAccum >= 5) {
          state.scorePulseAccum -= 5;
          state.score += 1 * state.multiplier;
          setScore(state.score);
        }
      }

      state.scrollDistance += speed * rf;
      state.distanceSinceLastSpawn += speed * rf;

      // Spawn Entities
      if (!state.isCrashing && state.distanceSinceLastSpawn > 30) {
        state.distanceSinceLastSpawn -= 30;
        const spawnT = Math.min(1, state.difficultySeconds / SPAWN_RAMP_SECONDS);
        const spawnChance =
          SPAWN_CHANCE_BASE + (SPAWN_CHANCE_CAP - SPAWN_CHANCE_BASE) * spawnT;

        if (Math.random() < spawnChance) {
          const isCollectible = Math.random() < 0.25;

          const afkSpawn =
            state.idleSec >= IDLE_POSITION_SEC &&
            Math.abs(p.x - state.lastIdlePx) < 1 &&
            Math.abs(p.y - state.lastIdlePy) < 1;

          if (isCollectible) {
            const isFirstAid = Math.random() < 0.2; // 20% chance of first aid when a collectible spawns
            const radius = 12;
            const minX = radius * 2;
            const maxX = state.width - radius * 2;
            let cx = minX + Math.random() * (maxX - minX);
            if (afkSpawn) {
              const aim = p.x + p.width / 2 + (Math.random() - 0.5) * 90;
              cx = Math.min(maxX, Math.max(minX, aim));
            }
            state.collectibles.push({
              id: state.nextId++,
              x: cx,
              y: -50,
              radius: radius,
              color: isFirstAid ? '#10b981' : '#3b82f6',
              type: isFirstAid ? 'firstaid' : 'data'
            });
          } else {
            const rand = Math.random();
            let obsType: 'plane' | 'drone' | 'helicopter' = 'plane';
            let obsWidth = 40;
            let obsHeight = 40;
            let obsColor = '#94a3b8';

            if (rand < 0.15) {
              obsType = 'helicopter';
              obsWidth = 45;
              obsHeight = 45;
              obsColor = '#1e3a8a';
            } else if (rand < 0.55) {
              obsType = 'drone';
              obsWidth = 30;
              obsHeight = 30;
              obsColor = '#10b981';
            }

            const minX = obsWidth;
            const maxX = state.width - obsWidth;

            let startX = minX + Math.random() * (maxX - minX);
            if (afkSpawn) {
              const aim = p.x + p.width / 2 + (Math.random() - 0.5) * 110;
              startX = Math.min(maxX, Math.max(minX, aim));
            }
            state.obstacles.push({
              id: state.nextId++,
              x: startX - obsWidth/2,
              y: -50,
              width: obsWidth,
              height: obsHeight,
              type: obsType,
              color: obsColor,
              startX: startX - obsWidth/2,
              range: Math.random() * 50 + 30,
              phase: Math.random() * Math.PI * 2
            });
          }
        }
      }

      // Update Projectiles
      for (let i = state.projectiles.length - 1; i >= 0; i--) {
        const proj = state.projectiles[i];
        proj.y += proj.vy * rf;

        let hit = false;
        for (let j = state.obstacles.length - 1; j >= 0; j--) {
          const obs = state.obstacles[j];
          if (
            proj.x < obs.x + obs.width &&
            proj.x + 4 > obs.x &&
            proj.y < obs.y + obs.height &&
            proj.y + 12 > obs.y
          ) {
            hit = true;
            // Explosion
            spawnParticles(obs.x + obs.width/2, obs.y + obs.height/2, obs.color, 30, 8);
            spawnParticles(obs.x + obs.width/2, obs.y + obs.height/2, '#ef4444', 15, 5);
            
            // Points
            let points = 20;
            if (obs.type === 'drone') points = 40;
            if (obs.type === 'helicopter') points = 60;
            state.score += points * state.multiplier;
            setScore(state.score);
            
            state.obstacles.splice(j, 1);
            break;
          }
        }

        if (hit || proj.y < -20) {
          state.projectiles.splice(i, 1);
        }
      }

      // Update Collectibles
      for (let i = state.collectibles.length - 1; i >= 0; i--) {
        const col = state.collectibles[i];
        col.y += speed * rf;

        if (!state.isCrashing) {
          const distX = Math.abs(col.x - (p.x + p.width/2));
          const distY = Math.abs(col.y - (p.y + p.height/2));

          if (distX <= (p.width/2 + col.radius) && distY <= (p.height/2 + col.radius)) {
            spawnParticles(col.x, col.y, col.color, 20, 5);
            
            if (col.type === 'firstaid') {
              if (state.player.health < 3) {
                state.player.health += 1;
                setHealth(state.player.health);
              }
              state.score += 100; // Bonus points for collecting
              setScore(state.score);
            } else {
              state.score += 50;
              state.multiplier = 2;
              state.multiplierTimer = 300;
              setScore(state.score);
              setMultiplier(2);
              setMultiplierTimeLeft(300);
            }
            
            state.collectibles.splice(i, 1);
            continue;
          }
        }

        if (col.y > state.height + 50) {
          state.collectibles.splice(i, 1);
        }
      }

      // Update Obstacles
      for (let i = state.obstacles.length - 1; i >= 0; i--) {
        const obs = state.obstacles[i];
        
        if (obs.type === 'drone') {
          obs.y += speed;
          obs.x = obs.startX + Math.sin(state.tRef * 0.05 + obs.phase) * obs.range;
        } else if (obs.type === 'helicopter') {
          obs.y += speed + 1.0; // Helicopters fly slightly faster than drones
          obs.x = obs.startX + Math.sin(state.tRef * 0.02 + obs.phase) * (obs.range * 1.5); // Wider, slower sweep
        } else {
          obs.y += speed + 2.5; // Planes fly towards player faster
        }

        // Collision with Player
        if (!state.isCrashing && state.invulnerableTimer <= 0) {
          if (
            p.x < obs.x + obs.width &&
            p.x + p.width > obs.x &&
            p.y < obs.y + obs.height &&
            p.y + p.height > obs.y
          ) {
            const bounceVx = (p.x + p.width/2 > obs.x + obs.width/2) ? 8 : -8;
            initiateCrash(bounceVx, 8);
          }
        }

        if (obs.y > state.height + 50) {
          state.obstacles.splice(i, 1);
        }
      }

      // Particles update
      for (let i = state.particles.length - 1; i >= 0; i--) {
        const part = state.particles[i];
        part.x += part.vx * rf;
        part.y += part.vy * rf;
        part.life += rf;
        if (part.life >= part.maxLife) {
          state.particles.splice(i, 1);
        }
      }
    };

    const draw = () => {
      // Clear background
      ctx.fillStyle = '#020617'; // slate-950
      ctx.fillRect(0, 0, state.width, state.height);

      ctx.save();
      
      // Screen Shake during crash or damage
      if (state.isCrashing) {
        const intensity = (state.crashTimer / 60) * 8;
        const shakeX = (Math.random() - 0.5) * intensity;
        const shakeY = (Math.random() - 0.5) * intensity;
        ctx.translate(shakeX, shakeY);
      } else if (state.invulnerableTimer > 100) {
        // Brief shake when taking damage (first 20 frames of 120)
        const intensity = ((state.invulnerableTimer - 100) / 20) * 5;
        const shakeX = (Math.random() - 0.5) * intensity;
        const shakeY = (Math.random() - 0.5) * intensity;
        ctx.translate(shakeX, shakeY);
      }

      // --- Draw Map Background ---
      // Disable image smoothing for sharper tiles if desired, or keep it on for smoother scaling
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const currentPixelX = START_PIXEL_X_BASE - state.width / 2;
      // We are flying North, so Y coordinate decreases
      const currentPixelY = START_PIXEL_Y - state.scrollDistance;

      const minTx = Math.floor(currentPixelX / 256);
      const maxTx = Math.floor((currentPixelX + state.width) / 256);
      const minTy = Math.floor(currentPixelY / 256);
      const maxTy = Math.floor((currentPixelY + state.height) / 256);

      for (let tx = minTx; tx <= maxTx; tx++) {
        for (let ty = minTy; ty <= maxTy; ty++) {
          const img = getTile(MAP_ZOOM, tx, ty);
          if (img && img.complete) {
            // Use Math.floor to prevent sub-pixel rendering artifacts (seams between tiles)
            const drawX = Math.floor(tx * 256 - currentPixelX);
            const drawY = Math.floor(ty * 256 - currentPixelY);
            // Draw slightly larger to cover potential 1px gaps from rounding
            ctx.drawImage(img, drawX, drawY, 257, 257);
          }
        }
      }

      // Light overlay to wash out the map slightly and help elements stand out
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'; // white with opacity
      ctx.fillRect(0, 0, state.width, state.height);

      // Draw Collectibles
      state.collectibles.forEach(col => {
        ctx.save();
        ctx.translate(col.x, col.y);
        ctx.shadowBlur = 20 + Math.sin(state.tRef * 0.1) * 10;
        ctx.shadowColor = col.color;

        if (col.type === 'firstaid') {
          // Draw a first aid box
          ctx.fillStyle = '#fff';
          ctx.fillRect(-col.radius, -col.radius, col.radius * 2, col.radius * 2);
          
          ctx.fillStyle = '#ef4444'; // Red cross
          const crossThickness = col.radius * 0.4;
          const crossLength = col.radius * 1.2;
          ctx.fillRect(-crossThickness / 2, -crossLength / 2, crossThickness, crossLength);
          ctx.fillRect(-crossLength / 2, -crossThickness / 2, crossLength, crossThickness);
        } else {
          // Draw data core
          ctx.fillStyle = col.color;
          ctx.beginPath();
          ctx.arc(0, 0, col.radius, 0, Math.PI * 2);
          ctx.fill();
          
          ctx.fillStyle = '#fff';
          ctx.beginPath();
          ctx.arc(0, 0, col.radius * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        
        ctx.shadowBlur = 0;
        ctx.restore();
      });

      // Draw Obstacles
      state.obstacles.forEach(obs => {
        if (obs.type === 'drone') {
          drawEnemyDrone(ctx, obs);
        } else if (obs.type === 'helicopter') {
          drawHelicopter(ctx, obs);
        } else {
          drawPlane(ctx, obs);
        }
      });

      // Draw Projectiles
      state.projectiles.forEach(proj => {
        ctx.fillStyle = proj.color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = proj.color;
        ctx.beginPath();
        ctx.roundRect(proj.x, proj.y, 4, 12, 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });

      // Draw Drone Trail
      if (!state.isCrashing && state.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(state.trail[0].x, state.trail[0].y);
        for (let i = 1; i < state.trail.length; i++) {
          ctx.lineTo(state.trail[i].x, state.trail[i].y);
        }
        ctx.strokeStyle = state.multiplier > 1 ? '#3b82f6' : state.player.color;
        ctx.lineWidth = state.multiplier > 1 ? 6 : 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        const gradient = ctx.createLinearGradient(
          state.trail[0].x, state.trail[0].y, 
          state.trail[state.trail.length-1].x, state.trail[state.trail.length-1].y
        );
        const colorBase = state.multiplier > 1 ? '59, 130, 246' : '239, 68, 68';
        gradient.addColorStop(0, `rgba(${colorBase}, 0.8)`);
        gradient.addColorStop(1, `rgba(${colorBase}, 0)`);
        
        ctx.strokeStyle = gradient;
        ctx.stroke();
      }

      // Particles
      state.particles.forEach(p => {
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 1 - (p.life / p.maxLife);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1.0;

      // Player
      drawDrone(ctx, state.player);

      ctx.restore();
    };

    const loop = () => {
      update();
      if (gameState === 'playing') {
        draw();
        state.animationId = requestAnimationFrame(loop);
      }
    };

    state.animationId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(state.animationId);
  }, [gameState]);

  const startGame = () => {
    gameRef.current = {
      width: dimensions.width,
      height: dimensions.height,
      player: {
        x: dimensions.width / 2 - DRONE_SIZE / 2,
        y: dimensions.height - 120,
        width: DRONE_SIZE,
        height: DRONE_SIZE,
        vx: 0,
        vy: 0,
        color: '#ef4444',
        rotation: 0,
        health: 3
      },
      obstacles: [],
      collectibles: [],
      projectiles: [],
      trail: [],
      scrollDistance: 0,
      distanceSinceLastSpawn: 0,
      particles: [],
      keys: {},
      tRef: 0,
      difficultySeconds: 0,
      lastFrameTimeMs: 0,
      lastShotMs: performance.now(),
      scorePulseAccum: 0,
      multUiAccum: 0,
      crashFxAccum: 0,
      idleSec: 0,
      lastIdlePx: dimensions.width / 2 - DRONE_SIZE / 2,
      lastIdlePy: dimensions.height - 120,
      score: 0,
      multiplier: 1,
      multiplierTimer: 0,
      speedMultiplier: 1,
      animationId: 0,
      isCrashing: false,
      crashTimer: 0,
      invulnerableTimer: 0,
      nextId: 0,
    };
    setScore(0);
    setHealth(3);
    setMultiplier(1);
    setMultiplierTimeLeft(0);
    setGameState('playing');
  };

  useEffect(() => {
    if (gameState === 'gameover') {
      if (score > highScore) {
        setHighScore(score);
      }
    }
  }, [gameState, score, highScore]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 text-slate-100 font-sans overflow-hidden">
      {gameState !== 'playing' && gameState !== 'gameover' && (
        <div className="absolute top-28 left-0 right-0 z-20 text-center pointer-events-none sm:top-32">
          <h1 className="text-4xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-rose-400 to-orange-500 uppercase italic">
            Urban Drone Run
          </h1>
          <p className="text-slate-400 text-sm mt-1 tracking-widest uppercase">High Speed City Racing</p>
        </div>
      )}

      <div className="relative w-full h-screen overflow-hidden bg-slate-900">
        {/* Score HUD */}
        <div className="absolute top-14 left-4 right-4 flex justify-between items-start z-10 pointer-events-none sm:top-16">
          <div className="flex flex-col gap-2">
            <div className="bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-700/50 flex items-center gap-2">
              <span className="text-xs text-slate-400 uppercase font-bold tracking-wider">Score</span>
              <span className="text-xl font-mono font-bold text-rose-400">{score.toString().padStart(5, '0')}</span>
            </div>
            
            {/* Multiplier Indicator */}
            <div className={`transition-all duration-300 ${multiplier > 1 ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}>
              <div className="bg-blue-900/80 backdrop-blur px-3 py-1.5 rounded-lg border border-blue-500/50 flex flex-col gap-1 shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-blue-400 fill-blue-400 animate-pulse" />
                  <span className="text-lg font-black italic text-blue-400">x{multiplier}</span>
                </div>
                <div className="w-full h-1 bg-blue-950 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-blue-400 transition-all duration-100 ease-linear"
                    style={{ width: `${(multiplierTimeLeft / 300) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 items-end">
            <div className="bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded-lg border border-slate-700/50 flex items-center gap-2">
              <Trophy className="w-4 h-4 text-amber-400" />
              <span className="text-xl font-mono font-bold text-amber-400">{highScore.toString().padStart(5, '0')}</span>
            </div>
            
            {/* Health Indicator */}
            <div className="flex gap-1">
              {[...Array(3)].map((_, i) => (
                <Heart 
                  key={i} 
                  className={`w-6 h-6 ${i < health ? 'text-rose-500 fill-rose-500' : 'text-slate-700 fill-slate-800'}`} 
                />
              ))}
            </div>
          </div>
        </div>

        <canvas
          ref={canvasRef}
          width={dimensions.width}
          height={dimensions.height}
          className="block w-full h-full bg-slate-950"
          style={{ touchAction: 'none' }}
        />

        {/* Overlays */}
        {gameState === 'start' && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 text-center z-20">
            <div className="w-20 h-20 bg-rose-500/20 rounded-full flex items-center justify-center mb-6 animate-pulse">
              <Play className="w-10 h-10 text-rose-400 ml-1" />
            </div>
            <h2 className="text-2xl font-bold mb-2">Enter the Airspace</h2>
            <p className="text-slate-400 mb-8 max-w-[250px]">
              Use <kbd className="bg-slate-800 px-2 py-1 rounded text-rose-300 font-mono text-sm mx-1">WASD</kbd>, <kbd className="bg-slate-800 px-2 py-1 rounded text-rose-300 font-mono text-sm mx-1">Arrows</kbd>, or <span className="text-rose-300 font-semibold">touch drag</span> to steer.
              <br/><br/>
              <span className="text-slate-300">Desktop:</span> press <kbd className="bg-slate-800 px-2 py-1 rounded text-rose-300 font-mono text-sm mx-1">Space</kbd> to shoot.
              <br/>
              <span className="text-slate-300">Touch:</span> your drone <span className="text-rose-300 font-semibold">fires automatically</span>.
              <br/><br/>
              <span className="text-slate-500 text-sm">Staying still in one spot draws heavier traffic your way—keep moving.</span>
            </p>
            <button
              onClick={startGame}
              className="bg-rose-500 hover:bg-rose-400 text-slate-950 font-bold text-lg px-8 py-3 rounded-full transition-all transform hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(244,63,94,0.4)]"
            >
              Start Engine
            </button>
          </div>
        )}

        {gameState === 'gameover' && (
          <div className="absolute inset-0 bg-rose-950/90 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center z-20">
            <h2 className="text-4xl font-black text-rose-500 mb-2 uppercase tracking-widest">Hull Breach</h2>
            <p className="text-rose-200/70 mb-8">Drone destroyed on impact.</p>
            
            <div className="bg-slate-900/50 rounded-2xl p-6 w-full max-w-[250px] mb-8 border border-rose-500/20">
              <div className="text-sm text-slate-400 uppercase tracking-wider mb-1">Final Score</div>
              <div className="text-4xl font-mono font-bold text-white mb-4">{score}</div>
              
              {score >= highScore && score > 0 && (
                <div className="inline-block bg-amber-500/20 text-amber-400 text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wider border border-amber-500/30">
                  New High Score!
                </div>
              )}
            </div>

            <button
              onClick={startGame}
              className="flex items-center gap-2 bg-white hover:bg-slate-200 text-slate-900 font-bold text-lg px-8 py-3 rounded-full transition-all transform hover:scale-105 active:scale-95"
            >
              <RotateCcw className="w-5 h-5" />
              Deploy Again
            </button>
          </div>
        )}
      </div>
      
      <div className="mt-6 text-slate-500 text-xs flex gap-4">
        <span>Desktop: keyboard + Space | Touch: drag + auto-fire | Don&apos;t camp in one lane</span>
      </div>
    </div>
  );
}

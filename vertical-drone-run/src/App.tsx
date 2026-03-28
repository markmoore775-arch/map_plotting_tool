/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {ArrowLeft} from 'lucide-react';
import DroneGame from './components/DroneGame';

export default function App() {
  return (
    <>
      <a
        href="../training.html"
        className="fixed z-[100] inline-flex items-center gap-2 px-3 py-2 sm:px-4 rounded-full bg-black/55 text-slate-100 text-xs sm:text-sm font-semibold border border-white/15 hover:bg-black/75 pointer-events-auto backdrop-blur-sm max-w-[calc(100vw-1.5rem)]"
        style={{
          top: 'max(0.75rem, env(safe-area-inset-top))',
          right: 'max(0.75rem, env(safe-area-inset-right))',
        }}
      >
        <ArrowLeft size={18} className="shrink-0" />
        Training menu
      </a>
      <DroneGame />
    </>
  );
}

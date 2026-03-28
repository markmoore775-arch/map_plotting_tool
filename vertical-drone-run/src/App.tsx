/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import DroneGame from './components/DroneGame';

export default function App() {
  return (
    <>
      <header className="pointer-events-none fixed left-0 right-0 top-0 z-[100]">
        <nav
          className="pointer-events-auto flex items-center border-b border-slate-800/60 bg-slate-950/90 px-3 py-2 backdrop-blur-sm sm:px-4"
          aria-label="AirPlot home"
        >
          <a
            href="../index.html"
            className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <span aria-hidden="true" className="text-slate-400">
              ←
            </span>
            Welcome
          </a>
        </nav>
      </header>
      <DroneGame />
    </>
  );
}

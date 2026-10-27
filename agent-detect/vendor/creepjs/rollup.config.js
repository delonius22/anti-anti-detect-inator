// Bundles src/inator-entry.ts into ../../client/probes.js (one IIFE file).
// The same file runs in the page and in CreepJS's service/shared/dedicated
// worker probes, so it must stay a single classic script at /probes.js.
import typescript from '@rollup/plugin-typescript'
import terser from '@rollup/plugin-terser'

const banner = `/*! Page probes for the Anti-Anti-Detect-inator. Based on CreepJS
 * (https://github.com/abrahamjuliot/creepjs), MIT License, Copyright (c) Abraham Juliot.
 * Modified: no rendering, no logging, no cloud samples. Full notice: vendor/creepjs/LICENSE */`

export default {
  input: 'src/inator-entry.ts',
  output: { file: '../../client/probes.js', format: 'iife', sourcemap: false, banner },
  plugins: [
    typescript({ tsconfig: './tsconfig.build.json', compilerOptions: { outDir: '../../client' } }),
    // compress/mangle are OFF on purpose: they rewrite the code CreepJS lie
    // detection inspects and produced ~400 false "lies" on plain Chromium in testing.
    terser({ compress: false, mangle: false, keep_classnames: true, keep_fnames: true, format: { comments: /^!/ } }),
  ],
}

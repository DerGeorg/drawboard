import { defineBlock } from '../../index';
import { mountCounter } from './counter';

// The entry module of the sample plugin (manifest `entry`): bundled into index.js by
// scripts/plugin-bundle.mjs together with the SDK.
void defineBlock(mountCounter);

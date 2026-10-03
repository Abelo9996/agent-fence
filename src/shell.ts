#!/usr/bin/env node
import { runShell } from "./wrap.js";

process.exit(runShell(process.argv.slice(2)));

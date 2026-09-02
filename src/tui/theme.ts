import chalk from "chalk";
import type { SelectListTheme } from "@earendil-works/pi-tui";

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.cyan(text),
  selectedText: (text) => chalk.cyan.bold(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.yellow(text)
};

import chalk from "chalk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => chalk.cyan(text),
  selectedText: (text) => chalk.cyan.bold(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.yellow(text)
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.cyan(text),
  selectList: selectListTheme
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.cyan.bold(text),
  link: (text) => chalk.blue.underline(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.yellow(text),
  codeBlock: (text) => text,
  codeBlockBorder: (text) => chalk.dim(text),
  quote: (text) => chalk.italic(text),
  quoteBorder: (text) => chalk.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.cyan(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
  highlightCode: (code) => code.split("\n")
};

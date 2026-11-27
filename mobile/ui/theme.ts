export const colors = theme({
  colorScheme: "light",
  fontFamily: font("golos-text", { weights: [400, 600, 700, 800] }),
  bg: "#F5F6F8",
  surface: "#FFFFFF",
  text: "#111827",
  textMuted: "#6B7280",
  accent: "#635BFF",
  accentInk: "#453DC6",
  accentPressed: "#5148E8",
  ai: "#EEEDFF",
  aiStrong: "#E2DFFF",
  border: "#E4E7EE",
  control: "#EBEDF2",
  success: "#16A34A",
  successInk: "#166534",
  successSurface: "#EAF8EF",
  warningInk: "#92400E",
  warningSurface: "#FFF1DB",
  danger: "#B91C1C",
  dangerSurface: "#FEECEC",
  "comfort-left": 20,
  "comfort-right": 20,
  "comfort-bottom": 14,
});

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 };
export const radius = { control: 12, card: 16 };

export const type = {
  page: { fontSize: 32, lineHeight: 40, fontWeight: 700, letterSpacing: -1.2 },
  card: { fontSize: 17, lineHeight: 24, fontWeight: 700, letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 22, fontWeight: 400 },
  small: { fontSize: 13, lineHeight: 18, fontWeight: 400 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: 600 },
  button: { fontSize: 15, lineHeight: 21, fontWeight: 700 },
};

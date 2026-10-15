import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BrokerDesk — Key-in & Audit Assistant",
  description: "Internal Ontario Personal Lines key-in and audit review workspace.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

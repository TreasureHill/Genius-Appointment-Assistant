import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Genius Appointment Assistant",
  description: "Book homeowner appointments via email + SMS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

export const metadata = { title: "Enterprise AI Access Lab" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "40px auto", padding: "0 16px" }}>
        {children}
      </body>
    </html>
  );
}

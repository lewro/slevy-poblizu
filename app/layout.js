import "./globals.css";

export const metadata = {
  title: "Za rohem",
  description: "Mapa slevových voucherů — kavárny, restaurace a zážitky poblíž tebe.",
  manifest: "/manifest.json",
  icons: { icon: "/favicon.png", apple: "/icons/icon-192.png" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#22c55e",
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="cs">
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/sw.js').catch(function (err) {
                    console.error('SW registration failed', err);
                  });
                });
              }
            `,
          }}
        />
      </body>
    </html>
  );
}

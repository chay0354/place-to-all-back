import app from './app.js';

const port = process.env.PORT || 4000;

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Backend running at http://localhost:${port}`);
  });
}

export default app;

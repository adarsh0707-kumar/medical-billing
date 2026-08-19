const createApp = require("./app");

const PORT = process.env.PORT || 5000;

createApp().listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📦 Environment: ${process.env.NODE_ENV}`);
});

@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js LTS：https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次启动，正在安装项目依赖...
  call npm ci
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
if not exist public\models\Xenova\bge-small-zh-v1.5\onnx\model.onnx (
  call npm run setup:models
  if errorlevel 1 (
    echo 模型准备失败，请检查网络。
    pause
    exit /b 1
  )
)
if not exist .env.local if not defined DEEPSEEK_API_KEY (
  echo 请先把 .env.example 复制为 .env.local，在本机填写 DEEPSEEK_API_KEY。
  pause
  exit /b 1
)
echo 星语即将打开，请保持此窗口运行。关闭窗口可停止服务。
echo 使用固定地址 http://localhost:5173 ，以便继续访问原来的本地聊天记录。
call npm run dev -- --host localhost --port 5173 --strictPort --open
if errorlevel 1 (
  echo 启动失败。如果 5173 端口已占用，请先检查原来的星语服务是否仍在运行。
  pause
)

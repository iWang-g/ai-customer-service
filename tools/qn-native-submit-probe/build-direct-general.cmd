@echo off
setlocal
set "CL=/DNOMINMAX /DWIN32_LEAN_AND_MEAN"
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist build\staged mkdir build\staged
cl /nologo /std:c++17 /EHsc /W4 /O2 /DQN_ADMISSION_LIBRARY /DQN_DIRECT_GENERAL /DQN_DIRECT_LONG_TEXT /LD direct_once_hook.cpp live_admission.cpp /Fo:build\staged\ /Fe:build\staged\qn_direct_general_v3.dll /link bcrypt.lib user32.lib
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /W4 /O2 /DQN_ADMISSION_LIBRARY /DQN_DIRECT_GENERAL /DQN_DIRECT_LONG_TEXT direct_once.cpp live_admission.cpp /Fo:build\staged\ /Fe:build\staged\qn_direct_general_probe_v3.exe /link bcrypt.lib user32.lib
if errorlevel 1 exit /b 1
cl /nologo /std:c++17 /EHsc /W4 /O2 /DQN_ADMISSION_LIBRARY native_layout_test.cpp live_admission.cpp /Fo:build\staged\ /Fe:build\staged\native_layout_test.exe /link bcrypt.lib user32.lib
if errorlevel 1 exit /b 1
build\staged\native_layout_test.exe
exit /b %errorlevel%

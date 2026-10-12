@echo off
chcp 65001 >nul
title OneWayFW 紧急恢复防火墙
echo ========================================================
echo   OneWayFW 紧急恢复防火墙
echo ========================================================
echo.
echo 正在执行一键还原防火墙策略与清理托管规则...
"%~dp0OneWayFW.exe" -restore
echo.

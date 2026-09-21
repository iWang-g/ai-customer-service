#pragma once
#include <windows.h>
#include <atomic>
#include <cstdio>
#include <thread>

// Controller-side observation only. Never restore, activate, focus or send input.
class DirectWindowWatch {
  HWND window_;
  HWND foreground_ = nullptr;
  std::thread thread_;
  std::atomic<bool> stop_{false}, ready_{false}, valid_{false};
  unsigned samples_ = 0, notMinimized_ = 0, invalidWindow_ = 0;
  unsigned restoreEvents_ = 0, targetForegroundEvents_ = 0, changedForegroundSamples_ = 0;
  unsigned baselineMinimized_ = 0, finalMinimized_ = 0;
  inline static thread_local DirectWindowWatch* active_ = nullptr;
  static void CALLBACK Event(HWINEVENTHOOK, DWORD event, HWND window, LONG, LONG, DWORD, DWORD) {
    if (!active_ || window != active_->window_) return;
    if (event == EVENT_SYSTEM_MINIMIZEEND) ++active_->restoreEvents_;
    if (event == EVENT_SYSTEM_FOREGROUND) ++active_->targetForegroundEvents_;
  }
  void Pump() {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
  }
  void Sample() {
    ++samples_;
    if (!IsWindow(window_)) ++invalidWindow_;
    if (!IsIconic(window_)) ++notMinimized_;
    if (GetForegroundWindow() != foreground_) ++changedForegroundSamples_;
  }
public:
  explicit DirectWindowWatch(HWND window) : window_(window) {}
  ~DirectWindowWatch() { Stop(); }
  bool Start() {
    foreground_ = GetForegroundWindow(); baselineMinimized_ = !!IsIconic(window_);
    thread_ = std::thread([this] {
      active_ = this;
      HWINEVENTHOOK foreground = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND,
          nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT);
      HWINEVENTHOOK restored = SetWinEventHook(EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZEEND,
          nullptr, Event, 0, 0, WINEVENT_OUTOFCONTEXT);
      Sample(); valid_ = foreground && restored; ready_ = true;
      while (!stop_) { Pump(); Sample(); Sleep(5); }
      Pump(); Sample(); finalMinimized_ = !!IsIconic(window_);
      if (foreground) UnhookWinEvent(foreground);
      if (restored) UnhookWinEvent(restored);
      active_ = nullptr;
    });
    while (!ready_) Sleep(1);
    return valid_;
  }
  void Stop() { stop_ = true; if (thread_.joinable()) thread_.join(); }
  void Print() const {
    std::printf("WINDOW_WATCH ready=%d baseline_minimized=%u final_minimized=%u samples=%u "
        "not_minimized_samples=%u invalid_window_samples=%u restore_events=%u target_foreground_events=%u "
        "foreground_changed_samples=%u interval_ms=5\n", valid_.load(), baselineMinimized_, finalMinimized_, samples_,
        notMinimized_, invalidWindow_, restoreEvents_, targetForegroundEvents_, changedForegroundSamples_);
  }
};

package com.xingyu.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Saves only to a document explicitly chosen by the user. No broad storage permission. */
@CapacitorPlugin(name = "FileExport")
public class FileExportPlugin extends Plugin {
    private volatile boolean saving = false;

    @PluginMethod
    public void saveFile(PluginCall call) {
        String content = call.getString("content");
        if (content == null || content.length() > 50 * 1024 * 1024) {
            call.reject("文件为空或超过 50 MB，无法导出");
            return;
        }
        if (saving) {
            call.reject("请先完成上一次保存");
            return;
        }
        String filename = call.getString("filename", "星语备份.json");
        filename = filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("mimeType", "application/json"));
        intent.putExtra(Intent.EXTRA_TITLE, filename);
        saving = true;
        try {
            startActivityForResult(call, intent, "saveResult");
        } catch (Exception error) {
            saving = false;
            call.reject("无法打开系统保存窗口", error);
        }
    }

    @ActivityCallback
    private void saveResult(PluginCall call, ActivityResult result) {
        if (call == null) { saving = false; return; }
        Uri uri = result.getData() == null ? null : result.getData().getData();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            saving = false;
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        getBridge().execute(() -> {
            try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new java.io.IOException("无法写入所选位置");
                String content = call.getString("content", "");
                byte[] bytes = Boolean.TRUE.equals(call.getBoolean("base64", false))
                    ? Base64.decode(content, Base64.DEFAULT)
                    : content.getBytes(StandardCharsets.UTF_8);
                output.write(bytes);
                output.flush();
            } catch (Exception error) {
                saving = false;
                call.reject("文件保存失败，请选择其他位置后重试", error);
                return;
            }
            saving = false;
            JSObject saved = new JSObject();
            saved.put("saved", true);
            call.resolve(saved);
        });
    }
}

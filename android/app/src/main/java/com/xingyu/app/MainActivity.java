package com.xingyu.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileExportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

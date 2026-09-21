// Decompile one function and print a selected one-based line range.
// @category Qianniu

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;

public class QnDecompileRange extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 3) {
            printerr("Pass a function address, first line, and last line.");
            return;
        }
        Function function = getFunctionContaining(toAddr(arguments[0]));
        if (function == null) {
            printerr("No function contains " + arguments[0]);
            return;
        }
        int first = Integer.parseInt(arguments[1]);
        int last = Integer.parseInt(arguments[2]);

        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            printerr("Decompiler could not open program: " + decompiler.getLastMessage());
            return;
        }
        DecompileResults result = decompiler.decompileFunction(function, 240, monitor);
        if (!result.decompileCompleted()) {
            printerr("Decompile failed: " + result.getErrorMessage());
            decompiler.dispose();
            return;
        }

        println("FUNCTION " + function.getName(true) + " @ " + function.getEntryPoint());
        String[] lines = result.getDecompiledFunction().getC().split("\\R");
        int start = Math.max(1, first);
        int end = Math.min(lines.length, last);
        for (int line = start; line <= end; ++line) {
            println(String.format("%5d %s", line, lines[line - 1]));
        }
        decompiler.dispose();
    }
}

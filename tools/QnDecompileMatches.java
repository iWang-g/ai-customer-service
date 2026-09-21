// Decompile one function and print bounded context around matching text.
// @category Qianniu

import java.util.LinkedHashSet;
import java.util.Set;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;

public class QnDecompileMatches extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length < 2) {
            printerr("Pass a function address followed by one or more match terms.");
            return;
        }
        Function function = getFunctionContaining(toAddr(arguments[0]));
        if (function == null) {
            printerr("No function contains " + arguments[0]);
            return;
        }

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
        Set<Integer> selected = new LinkedHashSet<>();
        for (int index = 0; index < lines.length; ++index) {
            if (!matches(lines[index], arguments)) {
                continue;
            }
            for (int context = Math.max(0, index - 4);
                 context <= Math.min(lines.length - 1, index + 4);
                 ++context) {
                selected.add(context);
            }
        }
        int previous = -2;
        for (int index : selected) {
            if (index != previous + 1) {
                println("  ...");
            }
            println(String.format("%5d %s", index + 1, lines[index]));
            previous = index;
        }
        decompiler.dispose();
    }

    private boolean matches(String line, String[] arguments) {
        for (int index = 1; index < arguments.length; ++index) {
            if (line.contains(arguments[index])) {
                return true;
            }
        }
        return false;
    }
}
